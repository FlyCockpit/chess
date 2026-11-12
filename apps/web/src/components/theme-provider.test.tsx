import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ThemeProvider } from "./theme-provider";

it("forwards the response nonce to the inline SSR theme bootstrap", () => {
  const html = renderToStaticMarkup(
    <ThemeProvider
      nonce="response-nonce"
      storageKey="vite-ui-theme"
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <div />
    </ThemeProvider>,
  );
  expect(html).toMatch(/<script[^>]*nonce="response-nonce"/);
  expect(html).toContain("vite-ui-theme");
});
