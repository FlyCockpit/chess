import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  applyUci,
  beginTurn,
  boardAt,
  createMatch,
  type EngineEvaluation,
  finishMatch,
  type MatchArchive,
  matchStats,
  playHumanTurn,
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
import type { RunnerGameRecord, RunnerJournal, RunnerJournalRecord } from "./runner-journal";
import type { RunnerMatchAuthority, RunnerPolicy } from "./runner-policy";

type Message = Exclude<RunnerServerMessage, { type: "welcome" | "heartbeat" | "pong" }>;
type Game = {
  record: RunnerGameRecord;
  authority: RunnerMatchAuthority;
  signal: AbortSignal;
  task?: Promise<void>;
  commands: Set<string>;
  reconciled: boolean;
  stopRequested?: boolean;
  spectator?: AbortController;
  memory: NonNullable<MatchRunnerOptions["memory"]>;
};
export type RunnerHello = Extract<RunnerClientMessage, { type: "hello" }>["payload"];
type TerminalKind = "interrupted" | "stopped" | "completed";
type TerminalReplay = { record: RunnerGameRecord; signal: AbortSignal; commands: Set<string> };

function terminalPayload(archive: MatchArchive, kind: TerminalKind) {
  const ply = matchStats(archive).moves;
  return {
    kind,
    result: archive.result,
    termination: archive.termination,
    ply,
    fen: boardAt(archive).fen(),
    rejectedAttempts: archive.events
      .flatMap((event) =>
        event.type === "attempt" && !event.accepted && event.ply === ply
          ? [{ move: event.move, ...(event.stopReason ? { stopReason: event.stopReason } : {}) }]
          : [],
      )
      .slice(0, 32),
  };
}

/** A known result may be republished after loss of its ACK, never recomputed. */
function matchesAcceptedPrefix(
  record: RunnerGameRecord,
  accepted: Extract<RunnerServerMessage, { type: "resume" }>["payload"],
) {
  const moves = record.archive.events.filter((event) => event.type === "attempt" && event.accepted);
  if (
    accepted.acceptedSeq !== accepted.ply ||
    accepted.ply < record.confirmedPly ||
    accepted.ply > moves.length ||
    moves.length - accepted.ply > 1
  )
    return false;
  const last = moves[accepted.ply - 1];
  const index = last ? record.archive.events.indexOf(last) : -1;
  return accepted.fen === boardAt(record.archive, index).fen();
}

/** One local executor. Transport callbacks schedule work and return before any inference. */
export class RunnerGameLoop {
  readonly hello: RunnerHello;
  private readonly games = new Map<string, Game>();
  private readonly cancelled = new Set<string>();
  private readonly terminalReplays = new Map<string, TerminalReplay>();
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
    if (message.type === "stop") {
      this.terminalReplays.delete(message.matchId);
      await this.stop(message.matchId, message.payload.commandId, signal);
      return;
    }
    const replay = this.terminalReplays.get(message.matchId);
    if (replay) {
      if (
        replay.signal === signal &&
        message.type === "human-move" &&
        this.echoHumanMove(message.matchId, replay.record, message, signal)
      )
        return;
      if (replay.signal !== signal || message.type !== "resume") {
        this.send({ type: "error", payload: { code: "STALE" } }, signal);
        return;
      }
      if (replay.commands.has(message.payload.commandId)) {
        this.send({ type: "ack", payload: { commandId: message.payload.commandId } }, signal);
        return;
      }
      if (!matchesAcceptedPrefix(replay.record, message.payload) || replay.commands.size >= 4096) {
        this.send({ type: "error", payload: { code: "STALE" } }, signal);
        return;
      }
      replay.record.confirmedPly = message.payload.acceptedSeq;
      await this.options.journal.save(message.matchId, replay.record);
      replay.commands.add(message.payload.commandId);
      if (!this.send({ type: "ack", payload: { commandId: message.payload.commandId } }, signal))
        return;
      let ply = 0;
      for (const event of replay.record.archive.events) {
        if (event.type !== "attempt" || !event.accepted) continue;
        ++ply;
        if (
          ply > message.payload.acceptedSeq &&
          !this.send(
            {
              type: "move",
              matchId: message.matchId,
              payload: { uci: event.move, ply, fen: event.fen },
            },
            signal,
          )
        )
          return;
      }
      this.send(
        {
          type: "event",
          matchId: message.matchId,
          payload: terminalPayload(replay.record.archive, "completed"),
        },
        signal,
      );
      return;
    }
    const game = this.games.get(message.matchId);
    if (!game || game.signal !== signal) {
      this.send({ type: "error", payload: { code: "STALE" } }, signal);
      return;
    }
    if (
      message.type === "human-move" &&
      !game.task &&
      game.record.phase !== "uncertain" &&
      this.echoHumanMove(message.matchId, game.record, message, signal)
    )
      return;
    if (game.commands.has(message.payload.commandId)) {
      this.send({ type: "ack", payload: { commandId: message.payload.commandId } }, signal, game);
      return;
    }
    if (game.commands.size >= 4096) {
      game.authority.stop();
      this.send({ type: "error", payload: { code: "BUSY" } }, signal);
      return;
    }
    if (game.task || game.record.phase === "uncertain") {
      this.send({ type: "error", payload: { code: "BUSY" } }, signal, game);
      return;
    }
    const archive = game.record.archive;
    const ply = matchStats(archive).moves;
    if (message.type === "resume") {
      if (!matchesAcceptedPrefix(game.record, message.payload)) {
        game.authority.stop();
        await this.terminal(message.matchId, game, "interrupted");
        return;
      }
      game.commands.add(message.payload.commandId);
      game.reconciled = message.payload.acceptedSeq === ply;
      game.record.confirmedPly = message.payload.acceptedSeq;
      await this.persist(message.matchId, game);
      if (
        !this.send({ type: "ack", payload: { commandId: message.payload.commandId } }, signal, game)
      )
        return;
      if (game.reconciled) this.snapshot(message.matchId, game);
      else this.outputs(message.matchId, game, message.payload.acceptedSeq);
      return;
    }
    if (
      archive.status !== "running" ||
      game.record.phase === "terminal" ||
      message.payload.expectedSeq !== ply ||
      (message.type === "start" && (game.record.confirmedPly !== ply || !game.reconciled))
    ) {
      this.send({ type: "error", payload: { code: "STALE" } }, signal, game);
      return;
    }
    game.authority.assertLive();
    if (message.type === "human-move") {
      if (
        archive.turn.type === "model" ||
        archive.config[boardAt(archive).turn() === "w" ? "white" : "black"].protocol !== "human"
      )
        throw new Error("RUNNER_GAME_TURN");
      // A malformed/illegal command must not mutate retries, clocks or the local board.
      if (message.payload.uci !== "resign") applyUci(boardAt(archive), message.payload.uci);
      game.commands.add(message.payload.commandId);
      game.record.phase = "uncertain";
      await this.persist(message.matchId, game);
      game.authority.assertLive();
      // The server already accepted this human move against its durable clock.
      // Local wall time cannot override that decision or fabricate a timeout.
      archive.turn = { type: "idle" };
      playHumanTurn(archive, boardAt(archive), 0, message.payload.uci);
      this.launchTurn(message.matchId, game, ply, true);
      return;
    }
    if (archive.turn.type !== "idle") {
      // A fresh process has no in-memory command receipt, but a reconciled
      // ready human turn proves parking completed before its old ACK was lost.
      // Recover only that receipt; never start another turn or reset its clock.
      if (
        game.record.phase === "ready" &&
        archive.turn.type === "human" &&
        archive.turn.side === boardAt(archive).turn() &&
        archive.turn.expectedSeq === archive.events.length &&
        archive.config[archive.turn.side === "w" ? "white" : "black"].protocol === "human"
      ) {
        game.commands.add(message.payload.commandId);
        await this.persist(message.matchId, game);
        game.authority.assertLive();
        if (
          !this.send(
            { type: "ack", payload: { commandId: message.payload.commandId } },
            signal,
            game,
          )
        )
          return;
        this.snapshot(message.matchId, game);
        return;
      }
      this.send({ type: "error", payload: { code: "STALE" } }, signal, game);
      return;
    }
    game.commands.add(message.payload.commandId);
    if (archive.config[boardAt(archive).turn() === "w" ? "white" : "black"].protocol === "human") {
      const now = this.now();
      // Parking records local UI state only. The server owns the running clock
      // and its deadline; a local clock estimate can never expire this turn.
      archive.turn = beginTurn(archive.turn, {
        type: "human",
        side: boardAt(archive).turn(),
        turnId: randomUUID(),
        expectedSeq: archive.events.length,
        startedAt: new Date(now).toISOString(),
        deadline: new Date(now + archive.config.rules.turnTimeoutMs).toISOString(),
      });
      game.record.phase = "ready";
      await this.persist(message.matchId, game);
      if (
        !this.send({ type: "ack", payload: { commandId: message.payload.commandId } }, signal, game)
      )
        return;
      this.snapshot(message.matchId, game);
      return;
    }
    // Persist the uncertainty fence before credentials, prices, inference or evaluation.
    game.record.phase = "uncertain";
    await this.persist(message.matchId, game);
    game.authority.assertLive();
    // Release delivery credit only after the no-repeat fence is durable. A
    // start ACK records receipt, never authority to dispatch another turn.
    if (
      !this.send({ type: "ack", payload: { commandId: message.payload.commandId } }, signal, game)
    )
      return;
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

  private async stop(matchId: string, commandId: string, signal: AbortSignal): Promise<void> {
    const game = this.games.get(matchId);
    if (game) {
      if (game.commands.has(commandId)) {
        this.send({ type: "ack", payload: { commandId } }, signal, game);
        return;
      }
      const reserved =
        game.commands.size === 4096 && !game.stopRequested && game.record.phase !== "terminal";
      if (game.commands.size >= 4096 && !reserved) {
        game.authority.stop();
        this.send({ type: "error", payload: { code: "BUSY" } }, signal);
        return;
      }
      game.commands.add(commandId);
      game.stopRequested = true;
      game.spectator?.abort();
      game.authority.stop();
      if (game.task) {
        // Serial journal writes cannot revive the terminal fence after late old work.
        await this.persist(matchId, game, { ...game.record, phase: "terminal" });
      } else await this.terminal(matchId, game, "stopped", signal);
      this.send({ type: "ack", payload: { commandId } }, signal, game);
      return;
    }
    if (this.cancelled.has(matchId)) {
      this.send({ type: "ack", payload: { commandId } }, signal);
      return;
    }
    if (this.games.size + this.cancelled.size >= 256) {
      this.send({ type: "error", payload: { code: "BUSY" } }, signal);
      return;
    }
    try {
      const stored = await this.options.journal.load(matchId);
      let terminal: RunnerJournalRecord;
      if (stored && stored.phase !== "cancelled") {
        if (stored.archive.status === "running")
          finishMatch(stored.archive, "*", "cancelled", "stopped");
        terminal = { ...stored, phase: "terminal" };
      } else terminal = { phase: "cancelled" };
      await this.options.journal.save(matchId, terminal);
      this.cancelled.add(matchId);
      this.send({ type: "ack", payload: { commandId } }, signal);
    } catch {
      this.poisoned = true;
      for (const item of this.games.values()) item.authority.stop();
      throw new Error("RUNNER_GAME_STORAGE");
    }
  }

  /** A server-accepted human command can outlive the socket that delivered it. */
  private echoHumanMove(
    matchId: string,
    record: RunnerGameRecord,
    message: Extract<Message, { type: "human-move" }>,
    signal: AbortSignal,
  ): boolean {
    const moves = record.archive.events.filter(
      (event) => event.type === "attempt" && event.accepted,
    );
    const last = moves.at(-1);
    if (
      last?.type !== "attempt" ||
      moves.length !== message.payload.expectedSeq + 1 ||
      last.move !== message.payload.uci ||
      record.archive.config[last.side === "w" ? "white" : "black"].protocol !== "human"
    )
      return false;
    this.send(
      { type: "move", matchId, payload: { uci: last.move, ply: moves.length, fen: last.fen } },
      signal,
    );
    return true;
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
    if (this.cancelled.has(message.matchId)) return reject("policy");
    let game = this.games.get(message.matchId);
    const terminal = this.terminalReplays.get(message.matchId)?.record ?? game?.record;
    if (terminal?.phase === "terminal" && terminal.archive.status === "completed" && !game?.task) {
      if (terminal.digest !== configDigest) return reject("policy");
      game?.spectator?.abort();
      game?.authority.finish();
      this.games.delete(message.matchId);
      this.terminalReplays.set(message.matchId, { record: terminal, signal, commands: new Set() });
      this.send({ type: "accept", matchId: message.matchId, payload: { commandId } }, signal);
      return;
    }
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
      return;
    }
    // Bound in-memory tombstones too. Disk tombstones are never silently discarded.
    if (this.games.size + this.cancelled.size + this.terminalReplays.size >= 256)
      return reject("busy");
    let stored: RunnerGameRecord | undefined;
    try {
      const loaded = await this.options.journal.load(message.matchId);
      if (loaded?.phase === "cancelled") return reject("policy");
      stored = loaded;
    } catch {
      this.poisoned = true;
      for (const item of this.games.values()) item.authority.stop();
      throw new Error("RUNNER_GAME_STORAGE");
    }
    if (stored?.phase === "terminal" && stored.archive.status === "completed") {
      const { prompt, ...settings } = stored.archive.config;
      if (
        stored.digest !== configDigest ||
        stored.archive.source !== "local" ||
        runnerConfigDigest({ ...settings, promptVersion: prompt.version }) !== configDigest
      )
        return reject("policy");
      this.terminalReplays.set(message.matchId, { record: stored, signal, commands: new Set() });
      this.send({ type: "accept", matchId: message.matchId, payload: { commandId } }, signal);
      return;
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
        // No external effect may precede this resumable durable state.
        phase: "ready",
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
      // Ready is durable before accept; loaded matches still require reconciliation.
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
          payload: terminalPayload(
            archive,
            archive.status === "completed" ? "completed" : "interrupted",
          ),
        },
        game.signal,
        game,
      );
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

  private async terminal(
    matchId: string,
    game: Game,
    kind: "interrupted" | "stopped" | "completed",
    signal = game.signal,
  ) {
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
        payload: terminalPayload(game.record.archive, kind),
      },
      signal,
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
