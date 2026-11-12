import messages from "@cockpit-chess/locales/src/en-US/chess.json";
import { createInstance } from "i18next";

const instance = createInstance();
void instance.init({
  lng: "en-US",
  fallbackLng: "en-US",
  initAsync: false,
  resources: {
    "en-US": {
      chess: messages,
      cli: {
        requestTimeout: "Request timed out",
        networkTimeout: "Could not reach {{server}}: timed out",
      },
    },
    "es-MX": {
      cli: {
        requestTimeout: "La solicitud agotó el tiempo de espera",
        networkTimeout: "No se pudo conectar con {{server}}: se agotó el tiempo de espera",
      },
    },
  },
  defaultNS: "chess",
  interpolation: { escapeValue: false },
});
export const t = (key: string, values?: Record<string, string | number>) => instance.t(key, values);
