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
        runner: {
          waiting: "Connecting runner transport. Local match execution is ready.",
          failed:
            "Runner startup failed. Retry with a new run, or explicitly resume an existing machine.",
          limitsRejected:
            "Operating limit revision {{revision}} rejected: updates are unavailable in this build.",
          providerHelp: "Local inference endpoint (never sent to the server)",
          modelsHelp: "Local model allowlist (narrows the locally fetched catalog)",
          concurrencyHelp: "Local hard concurrency ceiling",
        },
        requestTimeout: "Request timed out",
        networkTimeout: "Could not reach {{server}}: timed out",
        runnerConfig:
          "Invalid local runner policy. Check runner-policy.json and startup flags. Set OPENROUTER_API_KEY in your private terminal, or select a local loopback model.",
        runnerModel:
          "This model is not permitted locally or has no supported price bound. Choose an available model.",
        runnerRequest:
          "The provider request is unsupported. Use a permitted text model and a finite output limit.",
        runnerLimits:
          "The local runner limit was reached. Lower the request budget or change limits within the local ceiling.",
        runnerOffline:
          "The runner is stopped or disconnected. Reconnect before starting another request.",
        runnerUncertain:
          "A previous request or game has an uncertain outcome. No paid work was replayed. Run cockpit-chess runner-recover to inspect, then runner-recover --resolve-as-spent to count the full reservation as spent and abandon affected games.",
        runnerRecoveryFailed:
          "Local recovery refused: another runner is active, storage or process identity is unavailable, or a settlement violation remains blocked. Legacy PID-only locks cannot be reclaimed. Stop the other runner and inspect local storage; never delete the ledger or locks.",
        runnerRecoveryHelp: "Inspect uncertain local runner work; no network requests",
        runnerRecoveryConfirm:
          "Count full uncertain reservations as spent and abandon affected games",
        runnerRecoverySummary:
          "Unsettled requests: {{requests}}; uncertain games: {{games}}; settlement blocked: {{blocked}}; resolved: {{resolved}}",
        runnerRecoveryJson: "Print JSON",
        runnerRecoveryRootJson: "Print JSON for commands that support it",
        runnerRecoveryRequest:
          "Request {{requestId}} / match {{matchId}}: reserved {{reserved}} micros; charged {{micros}} micros; timestamp {{atMs}}",
        runnerRecoveryGame: "Match {{matchId}}: {{phase}}",
        runnerRecoveryYes: "yes",
        runnerRecoveryNo: "no",
        runnerRecoveryPhase: {
          offered: "offered",
          ready: "ready",
          uncertain: "uncertain",
          terminal: "terminal",
          cancelled: "cancelled",
        },
        runnerStorage:
          "Local authority is locked or its storage/process identity is unavailable. Stop any other runner, then inspect with cockpit-chess runner-recover. Legacy PID-only locks, unsupported local formats or corrupt records require local investigation; never delete state.",
        runnerPolicy:
          "Local price-checked ceilings: USD {{match}} per match, USD {{day}} per rolling 24 hours, {{concurrency}} concurrent. Operating limits: USD {{operatingMatch}} per match, USD {{operatingDay}} per rolling 24 hours, {{operatingConcurrency}} concurrent. Limits use prices checked right before each request. A provider price change in that window can exceed a limit once, after which the runner stops. Set a spend limit on the OpenRouter key for an absolute cap. Known final charges settle locally; calls without complete usage keep their full reservation.",
      },
    },
    "es-MX": {
      cli: {
        runner: {
          waiting: "Conectando el ejecutor. La ejecución local de partidas está lista.",
          failed:
            "No se pudo iniciar el ejecutor. Inicia una nueva ejecución o reanuda una máquina existente de forma explícita.",
          limitsRejected:
            "Se rechazó la revisión {{revision}} de límites operativos: las actualizaciones no están disponibles en esta versión.",
          providerHelp: "Endpoint de inferencia local (nunca se envía al servidor)",
          modelsHelp:
            "Lista local de modelos permitidos (restringe el catálogo obtenido localmente)",
          concurrencyHelp: "Máximo local de partidas simultáneas",
        },
        requestTimeout: "La solicitud agotó el tiempo de espera",
        networkTimeout: "No se pudo conectar con {{server}}: se agotó el tiempo de espera",
        runnerConfig:
          "La política local del ejecutor no es válida. Revisa runner-policy.json y las opciones de inicio. Configura OPENROUTER_API_KEY en tu terminal privada o selecciona un modelo local de loopback.",
        runnerModel:
          "Este modelo no está permitido localmente o no tiene un límite de precio compatible. Elige un modelo disponible.",
        runnerRequest:
          "La solicitud al proveedor no es compatible. Usa un modelo de texto permitido y un límite de salida finito.",
        runnerLimits:
          "Se alcanzó el límite local del ejecutor. Reduce el presupuesto de la solicitud o cambia los límites dentro del máximo local.",
        runnerOffline:
          "El ejecutor está detenido o desconectado. Vuelve a conectarlo antes de iniciar otra solicitud.",
        runnerUncertain:
          "Una solicitud o partida anterior tiene un resultado incierto. No se repitió ningún trabajo de pago. Ejecuta cockpit-chess runner-recover para inspeccionar y luego runner-recover --resolve-as-spent para contabilizar la reserva completa como gasto y abandonar las partidas afectadas.",
        runnerRecoveryFailed:
          "Se rechazó la recuperación local: otro ejecutor está activo, el almacenamiento o la identidad del proceso no está disponible, o sigue bloqueada una infracción de liquidación. No se pueden recuperar bloqueos antiguos que solo contienen un PID. Detén el otro ejecutor y revisa el almacenamiento local; nunca borres el registro ni los bloqueos.",
        runnerRecoveryHelp: "Inspeccionar trabajo local incierto sin solicitudes de red",
        runnerRecoveryConfirm:
          "Contabilizar las reservas inciertas completas como gasto y abandonar las partidas afectadas",
        runnerRecoverySummary:
          "Solicitudes sin liquidar: {{requests}}; partidas inciertas: {{games}}; liquidación bloqueada: {{blocked}}; resuelto: {{resolved}}",
        runnerRecoveryJson: "Mostrar JSON",
        runnerRecoveryRootJson: "Mostrar JSON para los comandos compatibles",
        runnerRecoveryRequest:
          "Solicitud {{requestId}} / partida {{matchId}}: reserva de {{reserved}} micros; cargo de {{micros}} micros; fecha {{atMs}}",
        runnerRecoveryGame: "Partida {{matchId}}: {{phase}}",
        runnerRecoveryYes: "sí",
        runnerRecoveryNo: "no",
        runnerRecoveryPhase: {
          offered: "ofrecida",
          ready: "lista",
          uncertain: "incierta",
          terminal: "finalizada",
          cancelled: "cancelada",
        },
        runnerStorage:
          "La autoridad local está bloqueada o su almacenamiento o identidad de proceso no está disponible. Detén los otros ejecutores e inspecciona con cockpit-chess runner-recover. Los bloqueos antiguos que solo contienen un PID, los formatos locales no compatibles o los registros dañados requieren investigación local; nunca borres el estado.",
        runnerPolicy:
          "Máximos locales con precios verificados: USD {{match}} por partida, USD {{day}} por 24 horas continuas, {{concurrency}} simultáneas. Límites operativos: USD {{operatingMatch}} por partida, USD {{operatingDay}} por 24 horas continuas, {{operatingConcurrency}} simultáneas. Los límites usan precios verificados justo antes de cada solicitud. Un cambio de precio del proveedor en ese intervalo puede superar un límite una vez; después, el ejecutor se detiene. Establece un límite de gasto en la clave de OpenRouter para un tope absoluto. Los cargos finales conocidos se liquidan localmente; las llamadas sin datos completos conservan su reserva total.",
      },
    },
  },
  defaultNS: "chess",
  interpolation: { escapeValue: false },
});
// i18next 27 types reject an explicit `undefined` options argument.
export const t = (key: string, values?: Record<string, string | number>) =>
  values === undefined ? instance.t(key) : instance.t(key, values);
