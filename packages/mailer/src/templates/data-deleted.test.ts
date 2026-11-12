import { describe, expect, it } from "vitest";
import { renderDataDeleted } from "./data-deleted.js";

const notice = {
  locale: "en-US",
  name: "20261101000000_drop_field",
  effects: "column match.legacy",
  deletedAt: new Date("2026-11-11T12:00:00Z"),
  backup: "pre-drop-20261111.dump",
  note: "retired field",
};

describe("renderDataDeleted", () => {
  it.each(["en-US", "es-MX"])("renders localized recovery instructions in %s", (locale) => {
    const { subject, html } = renderDataDeleted({ ...notice, locale });
    expect(subject).toBe(
      locale === "es-MX"
        ? "Se completó la eliminación programada de datos"
        : "Planned data deletion completed",
    );
    expect(html).toContain(`<html lang="${locale}">`);
    for (const value of [
      notice.name,
      notice.effects,
      notice.backup,
      notice.note,
      "restore",
      "docs/schema-migrations.md",
    ])
      expect(html).toContain(value);
  });

  it("falls back to English, names missing backup honestly, and omits optional notes", () => {
    const { subject, html } = renderDataDeleted({
      ...notice,
      locale: "unknown",
      backup: null,
      note: null,
      effects: null,
    });
    expect(subject).toBe("Planned data deletion completed");
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain("No backup was configured");
    expect(html).toContain("contract.sql");
    expect(html).not.toContain("<dt>Notes</dt>");
    expect(html).not.toContain("Backup taken before deletion");
  });

  it("escapes every runtime field", () => {
    const hostile = '<img src=x onerror="boom">';
    const { html } = renderDataDeleted({
      ...notice,
      name: hostile,
      effects: hostile,
      backup: hostile,
      note: hostile,
    });
    expect(html).not.toContain(hostile);
    expect(html.match(/&lt;img/g)).toHaveLength(4);
  });
});
