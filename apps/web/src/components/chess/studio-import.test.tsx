import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({
  importOptions: undefined as { meta?: Record<string, unknown> } | undefined,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { hostedEnabled: true } }),
  useInfiniteQuery: () => ({
    data: { pages: [{ items: [] }] },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    chess: {
      key: () => ["chess"],
      studio: { infiniteOptions: () => ({}) },
      info: { queryOptions: () => ({}) },
      inspect: { queryOptions: () => ({}) },
      publish: { mutationOptions: () => ({}) },
      stop: { mutationOptions: () => ({}) },
      importGame: {
        mutationOptions: (options: { meta?: Record<string, unknown> }) => {
          seen.importOptions = options;
          return options;
        },
      },
    },
    openrouter: { status: { queryOptions: () => ({}) } },
  },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: { status: "authenticated", session: { user: { role: "admin" } } },
  }),
}));
vi.mock("@/hooks/use-document-admits", () => ({ useDocumentAdmits: () => true }));
vi.mock("@/hooks/use-runner-controls", () => ({
  useRunnerControls: () => ({ accessDenied: false }),
}));
vi.mock("@/hooks/use-hosted-human-turn", () => ({
  useHostedHumanTurn: () => ({ accessDenied: false }),
}));
vi.mock("@/hooks/use-entity-mutation", () => ({
  useEntityMutation: () => ({ isPending: false, isError: false, mutate: vi.fn(), reset: vi.fn() }),
}));
vi.mock("./create-match-dialog", () => ({ CreateMatchDialog: () => null }));
vi.mock("./replay", () => ({ MatchReplay: () => null }));
// Render the dialog as if open: the static renderer cannot open a portal.
vi.mock("@cockpit-chess/ui/components/dialog", () => {
  const Pass = ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  );
  return {
    Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
    DialogTrigger: () => null,
    DialogClose: ({ children }: { children: ReactNode }) => (
      <button type="button">{children}</button>
    ),
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogFooter: Pass,
    DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  };
});

import { Studio } from "./studio";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess, common: enCommon } },
    defaultNS: "chess",
    react: { useSuspense: false },
  });
});

it("offers a labelled file button first, JSON paste behind a closed disclosure, and Cancel + Import", () => {
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <Studio onWatch={vi.fn()} />
    </I18nextProvider>,
  );
  const dialog = html.slice(html.indexOf(enChess.studio.archiveTitle));
  expect(dialog).toContain(enChess.studio.importDescription);
  expect(dialog).not.toContain(enChess.studio.description);
  // The visible file button wraps the (visually hidden, still focusable) native input.
  expect(dialog).toMatch(
    /<label class="cc-file-drop">(?:(?!<\/label>).)*Choose a game archive(?:(?!<\/label>).)*<input class="sr-only" type="file"/,
  );
  const paste = dialog.indexOf(enChess.studio.importPaste);
  expect(paste).toBeGreaterThan(dialog.indexOf("Choose a game archive"));
  expect(dialog).toMatch(/<details class="cc-settings-section">/);
  expect(dialog).toContain(">Cancel<");
  // Nothing chosen yet: the primary action waits for a file (or pasted JSON).
  expect(dialog).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Import<\/button>/);
  // A rejected archive is reported inline in the dialog only, never also as a toast.
  expect(seen.importOptions?.meta?.skipGlobalErrorToast).toBe(true);
});
