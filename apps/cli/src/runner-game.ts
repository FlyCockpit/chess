import { Buffer } from "node:buffer";
import {
  applyUci,
  beginHostedTurn,
  boardAt,
  createMatch,
  type EngineEvaluation,
  finishMatch,
  matchStats,
  playHostedHumanTurn,
  protocolForModel,
} from "@cockpit-chess/chess";
import {
  advanceMatch,
  evaluateAfterMove,
  type MatchRunnerOptions,
} from "@cockpit-chess/chess/runner";
import {
  RUNNER_MAX_FRAME_BYTES,
  type RunnerClientMessage,
  type RunnerServerMessage,
  runnerClientMessageSchema,
  runnerConfigDigest,
  runnerServerMessageSchema,
} from "@cockpit-chess/chess/runner-protocol";
import { localCredentials } from "./chess-provider";
import type { RunnerClientAction } from "./runner-connection";
import { evaluateRunnerPosition } from "./runner-engine";
import type { RunnerGameRecord, RunnerJournal } from "./runner-journal";
import type { RunnerMatchAuthority, RunnerPolicy } from "./runner-policy";

type Message = Exclude<RunnerServerMessage, { type: "welcome" | "heartbeat" | "pong" }>;
type Game = {
  record: RunnerGameRecord;
  authority: RunnerMatchAuthority;
  signal: AbortSignal;
  task?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  commands: Set<string>;
  reconciled: boolean;
  stopRequested?: boolean;
  spectator?: AbortController;
  memory: NonNullable<MatchRunnerOptions["memory"]>;
};
export type RunnerHello = Extract<RunnerClientMessage, { type: "hello" }>["payload"];

/** One local executor. Transport callbacks schedule work and return before any inference. */
export class RunnerGameLoop {
  readonly hello: RunnerHello;
  private readonly games = new Map<string, Game>();
  private readonly tasks = new Set<Promise<void>>();
  private closed = false;
  private closing?: Promise<void>;
  private poisoned = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      policy: RunnerPolicy;
      journal: RunnerJournal;
      engine: boolean;
      send(action: RunnerClientAction, signal: AbortSignal): boolean;
      /** Test seam; production always uses the common runner and local Stockfish. */
      advance?: typeof advanceMatch;
      evaluate?: typeof evaluateRunnerPosition;
      now?: () => number;
    },
  ) {
    const capability = options.policy.capabilities();
    let modelBytes = 0;
    const models = capability.models
      .map((id) => ({ id, protocol: protocolForModel(id) }))
      .filter(
        (model) =>
          runnerClientMessageSchema.safeParse({
            type: "hello",
            version: 1,
            generation: 0,
            id: "cap",
            seq: 1,
            ack: 0,
            payload: {
              models: [model],
              engine: options.engine,
              operatingLimits: { ...capability.operating, revision: capability.revision },
              hardLimits: { ...capability.hard },
            },
          }).success,
      )
      .filter((model) => {
        const bytes = Buffer.byteLength(JSON.stringify(model)) + 1;
        if (modelBytes + bytes > RUNNER_MAX_FRAME_BYTES - 1024) return false;
        modelBytes += bytes;
        return true;
      })
      .slice(0, 512);
    this.hello = {
      models,
      engine: options.engine,
      operatingLimits: { ...capability.operating, revision: capability.revision },
      hardLimits: { ...capability.hard },
    };
  }

  /** Also serialize direct callers; E2 already serializes wire callbacks. */
  handle(input: Message, signal: AbortSignal): Promise<void> {
    const action = this.tail.then(async () => {
      if (this.closed || this.poisoned || signal.aborted) return;
      try {
        const message = runnerServerMessageSchema.parse(input);
        if (message.type === "welcome" || message.type === "heartbeat" || message.type === "pong")
          return;
        await this.receive(message, signal);
      } catch {
        this.send({ type: "error", payload: { code: "INVALID" } }, signal);
      }
    });
    this.tail = action.catch(() => {});
    return action;
  }

  private send(action: RunnerClientAction, signal: AbortSignal, game?: Game): boolean {
    if (
      signal.aborted ||
      this.closed ||
      (this.poisoned && action.type !== "error" && action.type !== "reject")
    )
      return false;
    try {
      if (this.options.send(action, signal)) return true;
    } catch {
      // A synchronous adapter failure is the same loss of authority as backpressure.
    }
    // E2 closes the session on backpressure. Never continue a provider turn after a failed send.
    game?.authority.stop();
    return false;
  }

  private async persist(matchId: string, game: Game, snapshot = game.record): Promise<void> {
    try {
      await this.options.journal.save(matchId, snapshot);
    } catch {
      this.poisoned = true;
      for (const item of this.games.values()) item.authority.stop();
      throw new Error("RUNNER_GAME_STORAGE");
    }
  }

  private async receive(message: Message, signal: AbortSignal): Promise<void> {
    if (message.type === "ack" || message.type === "error") return;
    if (message.type === "limits") {
      // E3S owns step-up, terminal revision notices and the operating-update wire.
      this.send({ type: "error", payload: { code: "UNSUPPORTED" } }, signal);
      return;
    }
    if (message.type === "offer") {
      await this.offer(message, signal);
      return;
    }
    const game = this.games.get(message.matchId);
    if (!game || game.signal !== signal) {
      this.send({ type: "error", payload: { code: "STALE" } }, signal);
      return;
    }
    if (game.commands.has(message.payload.commandId)) {
      this.send({ type: "ack", payload: { commandId: message.payload.commandId } }, signal, game);
      return;
    }
    if (game.commands.size >= 4096) {
      game.authority.stop();
      this.send({ type: "error", payload: { code: "BUSY" } }, signal);
      return;
    }
    if (message.type === "stop") {
      game.commands.add(message.payload.commandId);
      clearTimeout(game.timer);
      game.stopRequested = true;
      game.spectator?.abort();
      game.authority.stop();
      if (game.task) {
        // The journal serializes this behind any pending result write. Once acknowledged,
        // even a crash before loop settlement can restore only this non-resumable fence.
        // Aborted tasks cannot enqueue a later ready write.
        await this.persist(message.matchId, game, { ...game.record, phase: "terminal" });
      } else await this.terminal(message.matchId, game, "stopped");
      this.send({ type: "ack", payload: { commandId: message.payload.commandId } }, signal, game);
      return;
    }
    if (game.task || game.record.phase === "uncertain") {
      this.send({ type: "error", payload: { code: "BUSY" } }, signal, game);
      return;
    }
    const archive = game.record.archive;
    const ply = matchStats(archive).moves;
    if (message.type === "resume") {
      if (
        message.payload.acceptedSeq !== ply ||
        message.payload.ply !== ply ||
        message.payload.fen !== boardAt(archive).fen()
      ) {
        game.authority.stop();
        await this.terminal(message.matchId, game, "interrupted");
        return;
      }
      game.commands.add(message.payload.commandId);
      game.reconciled = true;
      game.record.confirmedPly = ply;
      this.armHumanTimer(message.matchId, game);
      await this.persist(message.matchId, game);
      this.snapshot(message.matchId, game);
      return;
    }
    if (
      archive.status !== "running" ||
      game.record.phase === "terminal" ||
      message.payload.expectedSeq !== ply ||
      game.record.confirmedPly !== ply ||
      !game.reconciled
    ) {
      this.send({ type: "error", payload: { code: "STALE" } }, signal, game);
      return;
    }
    game.authority.assertLive();
    if (message.type === "human-move") {
      if (archive.turn.type !== "human") throw new Error("RUNNER_GAME_TURN");
      // A malformed/illegal command must not mutate retries, clocks or the local board.
      applyUci(boardAt(archive), message.payload.uci);
      game.commands.add(message.payload.commandId);
      clearTimeout(game.timer);
      game.record.phase = "uncertain";
      await this.persist(message.matchId, game);
      game.authority.assertLive();
      playHostedHumanTurn(archive, new Date(this.now()), message.payload.uci);
      this.launchTurn(message.matchId, game, ply, true);
      return;
    }
    if (archive.turn.type !== "idle") {
      this.send({ type: "error", payload: { code: "STALE" } }, signal, game);
      return;
    }
    game.commands.add(message.payload.commandId);
    if (archive.config[boardAt(archive).turn() === "w" ? "white" : "black"].protocol === "human") {
      beginHostedTurn(archive, new Date(this.now()));
      game.record.phase = archive.status === "running" ? "ready" : "terminal";
      await this.persist(message.matchId, game);
      this.snapshot(message.matchId, game);
      this.armHumanTimer(message.matchId, game);
      return;
    }
    // Persist the uncertainty fence before credentials, prices, inference or evaluation.
    game.record.phase = "uncertain";
    await this.persist(message.matchId, game);
    game.authority.assertLive();
    if (
      !this.send(
        { type: "event", matchId: message.matchId, payload: { kind: "started" } },
        signal,
        game,
      )
    )
      return;
    this.launchTurn(message.matchId, game, ply);
  }

  private async offer(message: Extract<Message, { type: "offer" }>, signal: AbortSignal) {
    const { config, configDigest, commandId } = message.payload;
    const reject = (reason: "busy" | "policy" | "unsupported") =>
      this.send(
        { type: "reject", matchId: message.matchId, payload: { commandId, reason } },
        signal,
      );
    if (runnerConfigDigest(config) !== configDigest) return reject("policy");
    for (const player of [config.white, config.black]) {
      if (["random", "human"].includes(player.protocol)) continue;
      if (
        !this.hello.models.some(
          (model) => model.id === player.model && model.protocol === player.protocol,
        )
      )
        return reject("policy");
    }
    const humans = [config.white, config.black].filter(
      (player) => player.protocol === "human",
    ).length;
    if (
      humans > 1 ||
      (humans && config.rules.context !== "fresh") ||
      (!this.hello.engine && config.rules.engineEvaluation !== "off")
    )
      return reject("unsupported");
    let game = this.games.get(message.matchId);
    if (game) {
      if (
        game.record.digest !== configDigest ||
        game.task ||
        game.record.phase === "terminal" ||
        game.record.phase === "uncertain"
      )
        return reject("busy");
      if (game.signal !== signal) {
        try {
          game.authority.resumeConnection(signal);
        } catch {
          return reject("busy");
        }
        game.signal = signal;
        game.reconciled = false;
      }
      this.send({ type: "accept", matchId: message.matchId, payload: { commandId } }, signal, game);
      this.snapshot(message.matchId, game);
      return;
    }
    // Bound in-memory tombstones too. Disk tombstones are never silently discarded.
    if (this.games.size >= 256) return reject("busy");
    let stored: RunnerGameRecord | undefined;
    try {
      stored = await this.options.journal.load(message.matchId);
    } catch {
      this.poisoned = true;
      for (const item of this.games.values()) item.authority.stop();
      throw new Error("RUNNER_GAME_STORAGE");
    }
    if (
      stored &&
      (stored.digest !== configDigest ||
        stored.phase !== "ready" ||
        stored.archive.config.rules.context !== "fresh")
    )
      return reject("policy");
    if (stored) {
      const { prompt, ...settings } = stored.archive.config;
      if (
        stored.archive.source !== "local" ||
        stored.archive.status !== "running" ||
        runnerConfigDigest({ ...settings, promptVersion: prompt.version }) !== configDigest
      )
        return reject("policy");
    }
    let authority: RunnerMatchAuthority;
    try {
      authority = this.options.policy.beginMatch(message.matchId, signal);
    } catch {
      return reject("busy");
    }
    game = {
      record: stored ?? {
        digest: configDigest,
        phase: "offered",
        archive: createMatch(config),
        confirmedPly: 0,
      },
      signal,
      authority,
      reconciled: !stored,
      commands: new Set([commandId]),
      memory: {},
    };
    this.games.set(message.matchId, game);
    try {
      await this.persist(message.matchId, game);
      authority.assertLive();
      if (
        !this.send(
          { type: "accept", matchId: message.matchId, payload: { commandId } },
          signal,
          game,
        )
      )
        return;
      // A loaded match must be explicitly reconciled, even if its last send succeeded.
      if (!stored) game.record.phase = "ready";
      this.snapshot(message.matchId, game);
      if (game.record.archive.status !== "running")
        await this.terminal(message.matchId, game, "completed");
    } catch {
      authority.stop();
      reject("policy");
    }
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }

  private launchTurn(matchId: string, game: Game, ply: number, human = false): void {
    const task = this.runTurn(matchId, game, ply, human);
    game.task = task;
    this.track(task);
    void task.then(() => {
      // Publication can let the next command start before this promise's continuation.
      if (game.task === task) game.task = undefined;
    });
  }

  private async runTurn(
    matchId: string,
    game: Game,
    beforePly: number,
    human = false,
  ): Promise<void> {
    try {
      game.authority.assertLive();
      if (human) {
        if (matchStats(game.record.archive).moves > beforePly)
          await evaluateAfterMove(game.record.archive, { signal: game.authority.signal });
      } else {
        const credentials = await localCredentials(
          game.record.archive,
          { runnerAuthority: game.authority },
          game.authority.signal,
        );
        game.authority.assertLive();
        await (this.options.advance ?? advanceMatch)(game.record.archive, {
          credentials,
          signal: game.authority.signal,
          memory: game.memory,
          conversationMaxBytes: 262_144,
        });
      }
      if (game.authority.signal.aborted) throw new Error("RUNNER_GAME_OFFLINE");
      const archive = game.record.archive;
      game.record.phase = archive.status === "running" ? "ready" : "terminal";
      await this.persist(matchId, game);
      // An explicit stop must become a tombstone even when it races result persistence.
      if (game.stopRequested) throw new Error("RUNNER_GAME_STOPPED");
      // The result is known and durable. A lost session may reconcile it, but cannot publish it now.
      if (game.authority.signal.aborted) {
        if (archive.status !== "running") game.authority.finish();
        return;
      }
      game.task = undefined;
      this.outputs(matchId, game, beforePly);
      this.queueSpectator(matchId, game);
    } catch {
      await this.terminal(matchId, game, game.stopRequested ? "stopped" : "interrupted").catch(
        () => {},
      );
    }
  }

  /** At most one current background position per game; a newer position cancels the old search. */
  private queueSpectator(matchId: string, game: Game): void {
    game.spectator?.abort();
    const terminal = game.record.archive.status !== "running";
    if (!this.options.engine || game.authority.signal.aborted || this.closed) {
      if (terminal) game.authority.finish();
      return;
    }
    const controller = new AbortController();
    game.spectator = controller;
    const signal = AbortSignal.any([controller.signal, game.authority.signal]);
    const fen = boardAt(game.record.archive).fen();
    const ply = matchStats(game.record.archive).moves;
    const nodes = game.record.archive.config.rules.engineNodes;
    const task = (async () => {
      try {
        const evaluation = await (this.options.evaluate ?? evaluateRunnerPosition)(
          fen,
          nodes,
          signal,
        );
        if (!signal.aborted && game.spectator === controller)
          this.evaluation(matchId, game, evaluation, "spectator", ply);
      } catch {
        // Spectator failure drops only this score; player-facing errors use common rules.
      } finally {
        if (game.spectator === controller) game.spectator = undefined;
        if (terminal) game.authority.finish();
      }
    })();
    this.track(task);
  }

  private outputs(matchId: string, game: Game, beforePly: number) {
    const archive = game.record.archive;
    let ply = 0;
    for (const event of archive.events) {
      if (event.type === "attempt" && event.accepted) {
        ply++;
        if (
          ply > beforePly &&
          !this.send(
            { type: "move", matchId, payload: { uci: event.move, ply, fen: event.fen } },
            game.signal,
            game,
          )
        )
          return;
      }
      if (event.type === "evaluation" && event.ply > beforePly)
        this.evaluation(matchId, game, event.evaluation, "player");
    }
    if (archive.status !== "running")
      this.send(
        {
          type: "event",
          matchId,
          payload: {
            kind: archive.status === "completed" ? "completed" : "interrupted",
            result: archive.result,
            termination: archive.termination,
          },
        },
        game.signal,
        game,
      );
    else this.snapshot(matchId, game);
  }

  private evaluation(
    matchId: string,
    game: Game,
    evaluation: EngineEvaluation,
    purpose: "player" | "spectator",
    ply = matchStats(game.record.archive).moves,
  ) {
    const score = evaluation.cp !== null ? { cp: evaluation.cp } : { mate: evaluation.mate ?? 0 };
    // Actual Stockfish searched nodes can overshoot go-nodes; the wire records the finite allowance.
    this.send(
      {
        type: "evaluation",
        matchId,
        payload: {
          fen: evaluation.fen,
          ply,
          nodes: game.record.archive.config.rules.engineNodes,
          score,
          purpose,
        },
      },
      game.signal,
      game,
    );
  }

  private snapshot(matchId: string, game: Game) {
    this.send(
      {
        type: "snapshot",
        matchId,
        payload: {
          acceptedSeq: Math.max(0, game.record.confirmedPly),
          fen: boardAt(game.record.archive).fen(),
          ply: matchStats(game.record.archive).moves,
        },
      },
      game.signal,
      game,
    );
  }

  private armHumanTimer(matchId: string, game: Game) {
    if (game.record.archive.turn.type !== "human") return;
    clearTimeout(game.timer);
    const deadline = Date.parse(game.record.archive.turn.deadline);
    game.timer = setTimeout(
      () => {
        void this.tail
          .then(async () => {
            if (
              this.closed ||
              game.task ||
              game.signal.aborted ||
              game.record.archive.turn.type !== "human"
            )
              return;
            playHostedHumanTurn(game.record.archive, new Date(Math.max(this.now(), deadline)));
            await this.terminal(matchId, game, "completed");
          })
          .catch(() => {
            game.authority.stop();
          });
      },
      Math.max(0, deadline - this.now()),
    );
    game.timer.unref();
  }

  private async terminal(
    matchId: string,
    game: Game,
    kind: "interrupted" | "stopped" | "completed",
  ) {
    clearTimeout(game.timer);
    game.spectator?.abort();
    if (game.record.archive.status === "running")
      finishMatch(
        game.record.archive,
        "*",
        kind === "stopped" ? "cancelled" : "interrupted",
        kind === "stopped" ? "stopped" : "error",
      );
    game.record.phase = "terminal";
    await this.persist(matchId, game);
    this.send(
      {
        type: "event",
        matchId,
        payload: {
          kind,
          result: game.record.archive.result,
          termination: game.record.archive.termination,
        },
      },
      game.signal,
      game,
    );
    game.authority.finish();
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  /** A lower operating budget aborts and durably fences every old authority; new games may start later. */
  stopActive(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const active = [...this.games.entries()].filter(
      ([, game]) => game.record.phase !== "terminal" || game.task !== undefined,
    );
    for (const [, game] of active) {
      game.stopRequested = true;
      clearTimeout(game.timer);
      game.spectator?.abort();
      game.authority.stop();
    }
    const task = this.tail.then(async () => {
      for (const [matchId, game] of active) {
        if (game.task) await this.persist(matchId, game, { ...game.record, phase: "terminal" });
        else if (game.record.phase !== "terminal") await this.terminal(matchId, game, "stopped");
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const game of this.games.values()) {
      clearTimeout(game.timer);
      game.spectator?.abort();
      game.authority.stop();
    }
    this.closing = (async () => {
      await this.tail;
      await Promise.all([...this.tasks]);
      const results = await Promise.allSettled([
        this.options.policy.close(),
        this.options.journal.close(),
      ]);
      if (results.some((result) => result.status === "rejected"))
        throw new Error("RUNNER_GAME_STORAGE");
    })();
    return this.closing;
  }
}
