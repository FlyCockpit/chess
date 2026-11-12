import enAdmin from "@cockpit-chess/locales/src/en-US/admin.json";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider, Trans } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Regression tests for the `<Trans>` rendering bugs this app shipped once: the
 * originals passed JSX children whose positional indices did not match the
 * `<N>` tags in the JSON, which produced duplicated phrases and dropped
 * `<code>` content. The fix is the explicit `components` prop, so the JSON
 * value stays the source of truth for both text and tag positions.
 *
 * These cover every `<0>`-carrying key in the shipped bundles. If a future
 * refactor reverts to children-as-source-of-truth, or an edit desyncs a
 * translated value from its `components` array, these snapshots diverge from
 * the JSON and the test fails loudly.
 */
describe("<Trans> components-prop rendering", () => {
  const i18n = createInstance();

  beforeAll(async () => {
    await i18n.init({
      lng: "en-US",
      fallbackLng: "en-US",
      ns: ["admin"],
      defaultNS: "admin",
      resources: {
        "en-US": { admin: enAdmin },
      },
      interpolation: { escapeValue: false },
      react: { useSuspense: false },
    });
  });

  function renderTrans(node: React.ReactElement): string {
    return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
  }

  it("renders setupBanner.message with <code> wrapping ADMIN_EMAILS", () => {
    const html = renderTrans(
      <Trans
        i18nKey="setupBanner.message"
        ns="admin"
        components={[<code key="0" className="font-mono" />]}
      />,
    );

    expect(html).toBe(
      'Set <code class="font-mono">ADMIN_EMAILS</code> in your environment and restart the server to enable admin features. See your deployment&#x27;s production hardening docs for details.',
    );
  });
});
