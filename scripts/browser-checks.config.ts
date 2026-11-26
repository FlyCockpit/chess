/**
 * The app's own settings for `pnpm check:dialogs` and
 * `pnpm check:shell-loading`: how to sign in, every dialog to open, and the
 * signed-in pages to hard-reload. The check scripts and
 * `browser-check-lib.ts` stay identical to the template's; only this file
 * changes per app.
 * Usage: docs/design-system.md § Browser checks
 *
 * Cockpit Chess has no mock mode: run the stack (`pnpm dev`) and pass its web
 * URL and an admin account, the password in the environment, never on the
 * command line (the same inputs as `pnpm check:layout`):
 *
 *   CHECK_LAYOUT_PASSWORD=… pnpm check:dialogs --url http://localhost:3001 --login admin@example.test
 */
import type { CheckRun } from "./browser-check-lib.ts";

/**
 * Start a mock-mode dev server when no `--url` is given. This app has no mock
 * mode: `--url` is required and `signIn` below signs in for real.
 */
export const MOCK_SERVER = false;

/**
 * Every dialog and page below is reachable by an admin, so one admin account
 * stands in for both roles.
 */
export type Role = "user" | "admin";

export interface SignInOptions {
  /** Mock-mode only (per-procedure scenarios); ignored without mock mode. */
  overrides?: Record<string, string>;
  /** Mock-mode only (slow responses); the shell check still throttles network and CPU. */
  slow?: boolean;
}

/**
 * Types a value into a React-controlled input through the native setter. The script goes over
 * stdin, so a password never appears in a process's arguments or in a failed command's message.
 */
function fillScript(selector: string, value: string): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
}

/** Waits (20s at most) until React has hydrated the sign-in form; a click before that reloads it. */
const FORM_HYDRATED = `(async () => {
  for (let i = 0; i < 40; i++) {
    const form = document.querySelector("form");
    if (form && Object.keys(form).some((key) => key.startsWith("__reactProps"))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
})()`;

/** After the sign-in submit: "app" once the app opens, "code" at the second-factor step, else null. */
const SIGN_IN_STEP = `location.pathname.endsWith("/settings") ? "app" : document.getElementById("totp-code") ? "code" : null`;

/** CDP's errors for an evaluation cut off by a page load (not a closed browser or session). */
const PAGE_NAVIGATED =
  /Inspected target navigated|Execution context was destroyed|Cannot find context with specified id/;

/**
 * Where the sign-in went (20s at most), polled with one short evaluation at a time: a sign-in with
 * `redirectTo` ends in a full page load (login.tsx), which aborts any evaluation still running in
 * the old page ("Inspected target navigated or closed"), so a navigation means "look again".
 */
export async function signInStep(
  run: (args: string[]) => Promise<string>,
  pause = (ms: number) => new Promise((done) => setTimeout(done, ms)),
): Promise<string> {
  let last = "an unknown page";
  let navigating: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      const step: unknown = JSON.parse(await run(["eval", SIGN_IN_STEP]));
      if (step === "app" || step === "code") return step;
      last = JSON.parse(await run(["eval", "location.pathname"])) as string;
      navigating = undefined;
    } catch (error) {
      if (!PAGE_NAVIGATED.test(String(error))) throw error;
      navigating = error;
    }
    await pause(500);
  }
  // Still mid-navigation after 20s: that error says more than the last page seen.
  if (navigating) throw navigating;
  return `still on ${last} after 20s`;
}

/** Clicks Verify once React has enabled it for the typed code (the button after the code field). */
const VERIFY_CODE = `(async () => {
  const button = document.getElementById("totp-code").closest("div").nextElementSibling;
  for (let i = 0; i < 20 && button.disabled; i++) await new Promise((r) => setTimeout(r, 100));
  button.click();
  return true;
})()`;

/** Browser sessions already signed in by this process: one sign-in per run, not per dialog. */
const signedIn = new WeakSet<CheckRun["browser"]>();

/**
 * Leaves the browser signed in with cookie consent decided (the banner is not
 * part of what the checks measure). Signs in once per run with the account
 * given as `--login <email>` and the password in CHECK_LAYOUT_PASSWORD (a
 * current code in CHECK_LAYOUT_TOTP if the account has a second factor);
 * later calls keep that session.
 */
export async function signIn(
  { base, browser, args }: CheckRun,
  _role: Role,
  _options: SignInOptions = {},
) {
  if (signedIn.has(browser)) return;
  const loginIndex = args.indexOf("--login");
  const email = loginIndex >= 0 ? args[loginIndex + 1] : undefined;
  const password = process.env.CHECK_LAYOUT_PASSWORD;
  if (!email || !password)
    throw new Error(
      "sign-in needs --login <admin email> and the password in CHECK_LAYOUT_PASSWORD",
    );
  // Straight to Settings, an app-shell page: the signed-in home is the public
  // arena (apps/web/src/lib/app-home.ts), so a plain sign-in leaves the app shell.
  await browser.run(["open", `${base}/en-US/login?redirectTo=%2Fen-US%2Fsettings`]);
  // A dev server's first load can outlast agent-browser's 25s limit for one wait.
  for (let attempt = 1; ; attempt++) {
    try {
      await browser.run(["wait", "input[autocomplete=current-password]"]);
      break;
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
  if (JSON.parse(await browser.run(["eval", "--stdin"], FORM_HYDRATED)) !== true)
    throw new Error("the sign-in form did not hydrate within 20s");
  await browser.run(["eval", "--stdin"], fillScript("input[type=email]", email));
  try {
    await browser.run(
      ["eval", "--stdin"],
      fillScript("input[autocomplete=current-password]", password),
    );
  } catch {
    // agent-browser may echo the failing script; never pass its output on.
    throw new Error("could not type the password into the sign-in form");
  }
  // Submitted in the page, not clicked: a click lands on whatever covers the button.
  await browser.run(["eval", 'document.querySelector("form").requestSubmit(); true']);
  const step = await signInStep((commandArgs) => browser.run(commandArgs));
  if (step === "code") {
    const code = process.env.CHECK_LAYOUT_TOTP;
    if (!code)
      throw new Error("this account has a second factor; put a current code in CHECK_LAYOUT_TOTP");
    try {
      await browser.run(["eval", "--stdin"], `${fillScript("#totp-code", code)} && ${VERIFY_CODE}`);
    } catch {
      throw new Error("could not submit the verification code");
    }
  } else if (step !== "app") {
    throw new Error(`sign-in did not open the app (${step})`);
  }
  await browser.run(["wait", "--url", "**/settings"]);
  await browser.run([
    "eval",
    "localStorage.setItem('cockpit-chess.consent.v1', JSON.stringify({ v: 1, analytics: false, decidedAt: Date.now() })); true",
  ]);
  signedIn.add(browser);
}

export type DialogStep =
  /** Click the first element matching a CSS selector. */
  | { click: string }
  /** Click the button, link or menu item whose trimmed text is exactly this. */
  | { clickText: string }
  /**
   * Wait until a CSS selector matches: between steps (a page that loads after a click), or
   * last, for a dialog that is still loading when it opens (measure its real content).
   */
  | { waitFor: string };

export interface DialogCase {
  /** Unique; shown in failures and used by `--only`. */
  name: string;
  /** Path with the locale, opened after signing in as `role`. */
  path: string;
  role: Role;
  overrides?: Record<string, string>;
  /** Wait for this selector before the steps. */
  ready: string;
  /** Steps that open the dialog. */
  steps: DialogStep[];
}

/**
 * Every dialog the app ships that an admin can open without changing data,
 * confirmations included. A dialog that cannot fit moves to a page or a wide
 * side sheet and leaves this list; there is no exemption field. Studio's
 * Create match is a wide side sheet (`SheetContent size="wide"`), so it is not
 * listed. Two cases need fixtures on the stack (an API key; a second user named
 * "Dialog Check Fixture"); opening their confirmations changes nothing. Not
 * listed: the invite's result dialog (only after a real invite).
 */
export const DIALOGS: DialogCase[] = [
  {
    name: "Import local archive",
    path: "/en-US/?tab=studio",
    role: "admin",
    ready: "main h1",
    steps: [{ clickText: "Import local archive" }],
  },
  {
    // The tallest state: the paste box open (the file preview and the box are alternatives).
    name: "Import local archive, paste open",
    path: "/en-US/?tab=studio",
    role: "admin",
    ready: "main h1",
    steps: [
      { clickText: "Import local archive" },
      { waitFor: '[data-slot="dialog-content"] summary' },
      { click: '[data-slot="dialog-content"] summary' },
      { waitFor: '[data-slot="dialog-content"] textarea' },
    ],
  },
  {
    // Needs one published game on the stack: the first card of the arena list. With none,
    // the `.cc-game-card` wait fails with that selector in the message.
    name: "Export video",
    path: "/en-US/",
    role: "admin",
    ready: ".cc-game-card",
    steps: [
      { click: ".cc-game-card" },
      { waitFor: '[data-slot="dialog-trigger"]' },
      { clickText: "Export video" },
      // The dialog opens on a codec probe; measure the options it shows afterwards.
      { waitFor: '[data-slot="dialog-content"] [data-slot="toggle-group"]' },
    ],
  },
  {
    name: "Create API key",
    path: "/en-US/settings/cli",
    role: "admin",
    ready: "main h1",
    steps: [{ clickText: "New API key" }],
  },
  {
    // Needs one API key (any name); opening the confirmation changes nothing.
    name: "Revoke API key",
    path: "/en-US/settings/cli",
    role: "admin",
    ready: "main h1",
    steps: [{ waitFor: "main ul li button" }, { clickText: "Revoke" }],
  },
  {
    // Needs a second user named "Dialog Check Fixture" (the signed-in admin's own Delete is
    // disabled); opening the confirmation changes nothing.
    name: "Delete user",
    path: "/en-US/admin/users",
    role: "admin",
    ready: "main h1",
    steps: [
      { waitFor: 'button[aria-label="Actions for Dialog Check Fixture"]' },
      { click: 'button[aria-label="Actions for Dialog Check Fixture"]' },
      { waitFor: '[role="menuitem"]' },
      { clickText: "Delete…" },
    ],
  },
  {
    name: "Invite user",
    path: "/en-US/admin/users",
    role: "admin",
    ready: "main h1",
    steps: [{ clickText: "Invite user" }],
  },
];

export interface ShellPage {
  name: string;
  path: string;
  role: Role;
  /**
   * A selector that exists only once the page's real content has loaded, not
   * in any skeleton (a row's action button, say; a card or a list item also
   * exists in the skeleton).
   */
  ready: string;
}

/** Signed-in pages `check:shell-loading` hard-reloads (pick two or more different shapes). */
export const SHELL_PAGES: ShellPage[] = [
  {
    name: "settings",
    path: "/en-US/settings",
    role: "admin",
    ready: 'main input[autocomplete="name"]',
  },
  {
    name: "admin users",
    path: "/en-US/admin/users",
    role: "admin",
    ready: '[aria-label^="Actions for "]',
  },
];
