import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ status: "anonymous" as string }));

vi.mock("@cockpit-chess/env/web", () => ({ env: { VITE_APP_NAME: "Cockpit Chess" } }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ className, children }: { className?: string; children?: React.ReactNode }) => (
    <a className={className}>{children}</a>
  ),
  useParams: () => ({ lang: "en-US" }),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: { status: authState.status } }),
}));
vi.mock("./main-nav", () => ({ MainNav: () => null }));
vi.mock("./language-switcher", () => ({ LanguageSwitcher: () => <i data-control="language" /> }));
vi.mock("./mode-toggle", () => ({ ModeToggle: () => <i data-control="mode" /> }));
vi.mock("./user-menu", () => ({ default: () => <i data-control="user-menu" /> }));

const { default: Header } = await import("./header");

// The class list of the div that holds the header controls.
function controlsGroupClasses() {
  const html = renderToStaticMarkup(<Header />);
  const match = html.match(/<div class="([^"]*)"><i data-control="language"/);
  if (!match?.[1]) throw new Error("controls group not found");
  return match[1].split(" ");
}

describe("Header controls group", () => {
  beforeEach(() => {
    authState.status = "anonymous";
  });

  it("stays on one line and lets the account trigger shrink when signed in", () => {
    authState.status = "authenticated";
    const classes = controlsGroupClasses();
    expect(classes).toEqual(expect.arrayContaining(["ml-auto", "flex", "min-w-0"]));
    expect(classes).not.toContain("flex-wrap");
    expect(classes).not.toContain("shrink-0");
  });

  it.each(["anonymous", "pending", "error"])(
    "wraps when %s, since Sign Up and Sign In cannot shrink",
    (status) => {
      authState.status = status;
      expect(controlsGroupClasses()).toEqual(
        expect.arrayContaining(["ml-auto", "max-w-full", "flex-wrap", "justify-end"]),
      );
    },
  );
});
