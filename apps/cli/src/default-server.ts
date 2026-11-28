// The server `cockpit-chess` talks to when nothing else names one — normally the
// product's production origin, so users can run `cockpit-chess login` straight after
// installing without configuring anything.
//
// Two ways to set it, the build-time one winning:
//   1. At compile time: COCKPIT_CHESS_DEFAULT_SERVER=https://app.example.com when
//      running scripts/compile.ts (CI reads the `COCKPIT_CHESS_DEFAULT_SERVER` repo
//      variable). The compile script inlines it as __COCKPIT_CHESS_DEFAULT_SERVER__.
//   2. Hardcoded: set HARDCODED_DEFAULT_SERVER below during the rebrand.
// The public origin makes a fresh no-argument runner usable without configuration.
// --server, COCKPIT_CHESS_SERVER and the local config still override this default.

declare const __COCKPIT_CHESS_DEFAULT_SERVER__: string | undefined;

const HARDCODED_DEFAULT_SERVER = "https://chess.flycockpit.app";

/** The built-in default server, or undefined when the build has none. */
export const DEFAULT_SERVER: string | undefined =
  (typeof __COCKPIT_CHESS_DEFAULT_SERVER__ === "string" && __COCKPIT_CHESS_DEFAULT_SERVER__) ||
  HARDCODED_DEFAULT_SERVER ||
  undefined;
