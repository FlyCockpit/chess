import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ env: { DATABASE_URL: "postgresql://u:p@db/app" } }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: state.env }));
vi.mock("../prisma/generated/client", () => ({ Prisma: { raw: (sql: string) => ({ raw: sql }) } }));
const { runnerSchema, runnerTable } = await import("./runner-tables");

beforeEach(() => {
  state.env.DATABASE_URL = "postgresql://u:p@db/app";
});

it("uses public for missing, empty, or invalid schema URLs", () => {
  for (const url of ["invalid", "postgresql://u:p@db/app", "postgresql://u:p@db/app?schema="]) {
    state.env.DATABASE_URL = url;
    expect(runnerSchema()).toBe("public");
  }
});

it("quotes schema and table identifiers instead of interpolating SQL", () => {
  state.env.DATABASE_URL = "postgresql://u:p@db/app?schema=tenant%22quoted";
  expect(runnerSchema()).toBe('tenant"quoted');
  expect(runnerTable('_cockpit_chess_"instance')).toEqual({
    raw: '"tenant""quoted"."_cockpit_chess_""instance"',
  });
});
