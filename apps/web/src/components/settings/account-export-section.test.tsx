import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  pending: null as "json" | "pgn" | "reauth" | null,
  issue: null as "reauth" | "rateLimit" | "forbidden" | "tooLarge" | "unavailable" | null,
  downloaded: false,
  download: vi.fn(),
  reauthenticate: vi.fn(),
}));
vi.mock("@/hooks/use-account-export", () => ({ useAccountExport: () => fixture }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { AccountExportSection } = await import("./account-export-section");
const render = () => renderToStaticMarkup(<AccountExportSection lang="en-US" />);
beforeEach(() => {
  fixture.pending = null;
  fixture.issue = null;
  fixture.downloaded = false;
});
describe("account export section", () => {
  it("explains both downloads and the fresh sign-in requirement", () => {
    const html = render();
    expect(html).toContain("export.title");
    expect(html).toContain("export.description");
    expect(html).toContain("export.freshSignIn");
    expect(html).toContain("export.json");
    expect(html).toContain("export.pgn");
    expect(html).not.toContain('role="alert"');
    expect(html.match(/min-h-11/g)).toHaveLength(2);
  });
  it("keeps download controls disabled and describes the pending step", () => {
    fixture.pending = "json";
    const html = render();
    expect(html.match(/ disabled=""/g)).toHaveLength(2);
    expect(html).toContain("export.preparing");
    expect(html).toContain("export.keepOpen");
  });
  it("offers an explicit sign-out/sign-in step after stale proof", () => {
    fixture.issue = "reauth";
    const html = render();
    expect(html).toContain("export.errors.reauth");
    expect(html).toContain("export.signInAgain");
    expect(html).toContain('role="alert"');
    expect(html.match(/ disabled=""/g)).toHaveLength(2);
  });
  it.each(["rateLimit", "forbidden", "tooLarge", "unavailable"] as const)(
    "shows the next action for %s",
    (issue) => {
      fixture.issue = issue;
      const html = render();
      expect(html).toContain(`export.errors.${issue}`);
      expect(html).not.toContain("export.signInAgain");
    },
  );
  it("confirms completion with a privacy reminder", () => {
    fixture.downloaded = true;
    expect(render()).toContain("export.downloaded");
  });
});
