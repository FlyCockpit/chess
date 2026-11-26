import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { LocalModelLab } from "@/components/chess/local-model-lab";
import i18n from "@/i18n";
import { followSystemScheme } from "@/lib/system-scheme";
import "./index.css";

// The lab has no theme toggle: it follows the OS setting, live. Module code, not an
// inline script, so the lab's strict CSP holds.
followSystemScheme(document.documentElement, matchMedia("(prefers-color-scheme: dark)"));
if (!i18n.isInitialized)
  await new Promise<void>((resolve) => i18n.once("initialized", () => resolve()));
const root = document.getElementById("root");
if (!root) throw new Error("Local mount unavailable");
createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <LocalModelLab />
      </QueryClientProvider>
    </I18nextProvider>
  </StrictMode>,
);
