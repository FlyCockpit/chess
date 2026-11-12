import enBundle from "../locales/en-US/data-deleted.json";
import esBundle from "../locales/es-MX/data-deleted.json";
import { type MailerLocale, resolveMailerLocale } from "../locales/index.js";
import { escapeHtml } from "./html.js";

const BUNDLES: Record<MailerLocale, typeof enBundle> = {
  "en-US": enBundle,
  "es-MX": esBundle,
};

export interface RenderDataDeletedArgs {
  locale: string;
  name: string;
  effects: string | null;
  deletedAt: Date;
  backup: string | null;
  note: string | null;
}

export function renderDataDeleted(args: RenderDataDeletedArgs): { subject: string; html: string } {
  const locale = resolveMailerLocale(args.locale);
  const bundle = BUNDLES[locale];
  const t = (key: keyof typeof enBundle) => bundle[key] || enBundle[key];
  const field = (key: keyof typeof enBundle, value: string) =>
    `<dt>${escapeHtml(t(key))}</dt><dd>${escapeHtml(value)}</dd>`;
  return {
    subject: t("subject"),
    html: `<!DOCTYPE html>
<html lang="${locale}"><head><meta charset="utf-8" /></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<h1>${escapeHtml(t("subject"))}</h1><p>${escapeHtml(t("body"))}</p>
<dl>${field("what", args.effects ?? t("fallbackEffects"))}
${field("when", args.deletedAt.toISOString())}${field("migration", args.name)}
${args.note ? field("notes", args.note) : ""}
${args.backup ? field("backup", args.backup) : ""}</dl>
<p>${escapeHtml(t(args.backup ? "recovery" : "noBackup"))}</p>
</body></html>`,
  };
}
