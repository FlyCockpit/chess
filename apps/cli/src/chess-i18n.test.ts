import { expect, it } from "vitest";
import { t } from "./chess-i18n";

it.each([
  ["en-US", "Request timed out", "Could not reach https://app: timed out"],
  [
    "es-MX",
    "La solicitud agotó el tiempo de espera",
    "No se pudo conectar con https://app: se agotó el tiempo de espera",
  ],
])("translates CLI request timeouts in %s", (lng, timeout, network) => {
  expect(t("cli:requestTimeout", { lng })).toBe(timeout);
  expect(t("cli:networkTimeout", { lng, server: "https://app" })).toBe(network);
});
