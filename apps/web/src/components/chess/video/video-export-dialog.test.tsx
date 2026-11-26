import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { expect, it } from "vitest";
import { VideoExportDialog } from "./video-export-dialog";
import { videoFixtureGame } from "./video-fixture";

it("renders only the trigger on the server, without touching browser APIs", async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { chess: enChess } }, defaultNS: "chess" });
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <VideoExportDialog match={videoFixtureGame()} />
    </I18nextProvider>,
  );
  expect(html).toContain("Export video");
  expect(html).not.toContain("Export MP4");
  expect(html).not.toContain("progressbar");
});
