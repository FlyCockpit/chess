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
import { type Account, type CheckRun, formSignIn } from "./browser-check-lib.ts";

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

/** Browser sessions already signed in by this process: one sign-in per run, not per dialog. */
const signedIn = new WeakSet<CheckRun["browser"]>();

/**
 * The account from `--login <email>` and CHECK_LAYOUT_PASSWORD (never the
 * command line), with CHECK_LAYOUT_TOTP read only when the second-factor step
 * shows. Fails with what to pass when either is missing.
 */
export function loginAccount(args: string[], env = process.env): Account {
  const loginIndex = args.indexOf("--login");
  const email = loginIndex >= 0 ? args[loginIndex + 1] : undefined;
  const password = env.CHECK_LAYOUT_PASSWORD;
  if (!email || email.startsWith("--") || !password)
    throw new Error(
      "sign-in needs --login <admin email> and the password in CHECK_LAYOUT_PASSWORD",
    );
  return {
    email,
    password,
    totp: () => {
      const code = env.CHECK_LAYOUT_TOTP;
      if (!code)
        throw new Error(
          "this account has a second factor; put a current code in CHECK_LAYOUT_TOTP (or use an account still in its enrollment grace)",
        );
      return code;
    },
  };
}

/**
 * Leaves the browser signed in with cookie consent decided (the banner is not
 * part of what the checks measure). Signs in once per run through the app's
 * sign-in form (`formSignIn`, landing on Settings) with `loginAccount`'s
 * account; later calls keep that session.
 */
export async function signIn(run: CheckRun, _role: Role, _options: SignInOptions = {}) {
  if (signedIn.has(run.browser)) return;
  await formSignIn(run, loginAccount(run.args));
  signedIn.add(run.browser);
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
  /** What the stack must hold for the dialog to open (shown when it does not). */
  needs?: string;
}

/**
 * Every dialog the app ships that an admin can open without changing data,
 * confirmations included. A dialog that cannot fit moves to a page or a wide
 * side sheet and leaves this list; there is no exemption field. Studio's
 * Create match is a wide side sheet (`SheetContent size="wide"`), so it is not
 * listed. Two cases need fixtures on the stack (an API key; a second user named
 * "Dialog Check Fixture"); opening their confirmations changes nothing. Not
 * listed: the invite's set-password link dialog. It opens only after a real
 * invite whose email could not be sent (with SMTP configured the invite just
 * toasts "Invite emailed to …"), and only its Done button closes it (no X;
 * Escape and the backdrop do nothing), so a check could not open it without
 * creating an account.
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
    needs: "one published game on the stack",
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
    needs: "an API key on the signed-in account (any name)",
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
    needs: 'a second user named "Dialog Check Fixture"',
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
  /** What the account must hold for `ready` to appear (shown when it does not). */
  needs?: string;
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
