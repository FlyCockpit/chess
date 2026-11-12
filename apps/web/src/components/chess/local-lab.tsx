import {
  boardAt,
  createMatch,
  finishMatch,
  legalMoves,
  MAX_ARCHIVE_BYTES,
  type MatchArchive,
  submitMove,
  validateArchive,
} from "@cockpit-chess/chess";
import { Download, RotateCcw, Upload } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChessBoard } from "./chess-board";
import { downloadGame, MatchReplay } from "./replay";

export function LocalLab() {
  const { t } = useTranslation("chess");
  const fresh = () =>
    createMatch({
      title: t("lab.baseline"),
      white: { name: t("lab.human"), model: "human", protocol: "human" },
      black: { name: t("lab.random"), model: "random", protocol: "random" },
      rules: { maxPlies: 200 },
    });
  const [match, setMatch] = useState<MatchArchive>(fresh);
  const [imported, setImported] = useState<MatchArchive | null>(null);
  const [error, setError] = useState("");
  const chess = boardAt(match);
  function move(uci: string) {
    if (match.status !== "running" || chess.turn() !== "w") return;
    const next = structuredClone(match);
    const board = boardAt(next);
    const attempt = submitMove(next, board, uci);
    if (attempt.accepted && next.status === "running") {
      const moves = legalMoves(board);
      const reply = moves[Math.floor(Math.random() * moves.length)];
      if (reply) submitMove(next, board, reply);
    }
    setMatch(next);
  }
  function stopAndExport() {
    const next = structuredClone(match);
    if (next.status === "running") finishMatch(next, "*", "cancelled", "stopped");
    setMatch(next);
    downloadGame(next, "json");
  }
  return (
    <>
      <div className="cc-baseline-layout">
        <section className="cc-board-panel">
          <div className="cc-player">
            <span className="cc-avatar">♚</span>
            <div>
              <strong>{t("lab.random")}</strong>
              <span>{t("lab.localOnly")}</span>
            </div>
          </div>
          <ChessBoard
            key={match.id}
            fen={chess.fen()}
            onMove={move}
            disabled={match.status !== "running"}
            lastMove={match.events
              .flatMap((event) => (event.type === "attempt" && event.accepted ? [event.move] : []))
              .at(-1)}
          />
          <div className="cc-player">
            <span className="cc-avatar cc-avatar-light">♔</span>
            <strong>{t("lab.human")}</strong>
          </div>
        </section>
        <aside className="cc-lab-instructions">
          <span className="cc-eyebrow">{t("lab.localOnly")}</span>
          <h2 className="mt-5">{t("lab.baseline")}</h2>
          <p>{t("lab.baselineDescription")}</p>
          <p aria-live="polite">
            {match.status === "running"
              ? t("lab.yourTurn")
              : t("lab.finished", { result: match.result })}
          </p>
          <div className="cc-form-grid">
            <button
              type="button"
              className="cc-button"
              onClick={() => {
                setMatch(fresh());
                setError("");
              }}
            >
              <RotateCcw size={16} />
              {t("lab.reset")}
            </button>
            <button type="button" className="cc-button cc-button-secondary" onClick={stopAndExport}>
              <Download size={16} />
              {t("lab.stop")}
            </button>
            <label className="cc-button cc-button-secondary">
              <Upload size={16} />
              {t("lab.import")}
              <input
                className="sr-only"
                type="file"
                accept=".json,application/json"
                onChange={async (event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  // Clear on every path (including rejection) so re-picking the same file fires onChange.
                  input.value = "";
                  if (!file) return;
                  if (file.size > MAX_ARCHIVE_BYTES) {
                    setError(t("lab.importTooLarge"));
                    return;
                  }
                  try {
                    setImported(validateArchive(JSON.parse(await file.text())));
                    setError("");
                  } catch {
                    setError(t("lab.importError"));
                  }
                }}
              />
            </label>
          </div>
          {error && (
            <p role="alert" className="cc-error">
              {error}
            </p>
          )}
        </aside>
      </div>
      {imported && (
        <div className="mt-10">
          <div className="cc-section-bar">
            <h2>{t("lab.import")}</h2>
          </div>
          <MatchReplay key={imported.id} match={imported} />
        </div>
      )}
    </>
  );
}
