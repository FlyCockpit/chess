import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@cockpit-chess/auth", () => ({ auth: {}, passwordPepper: {} }));
vi.mock("@cockpit-chess/env/shared", () => ({ env: { DATABASE_POOL_MAX: 5 } }));
vi.mock("@cockpit-chess/db", () => ({ default: {} }));
vi.mock("@cockpit-chess/auth/device-redemption-lock", () => ({
  lockCliCredentials: vi.fn(),
  withCliCredentialLockSlot: vi.fn(),
}));
const { accountExportModelPolicy } = await import("./account-export");

/** The generated runtime data model is Prisma's DMMF model/field projection. */
const runtimeDmmf = z.object({
  models: z.record(
    z.string(),
    z.object({
      fields: z.array(z.object({ name: z.string(), kind: z.string(), type: z.string() })),
    }),
  ),
});

describe("account export schema coverage", () => {
  it("requires every model with a relational path to User to be exported or explicitly excluded", async () => {
    const client = new PrismaClient({
      adapter: {
        provider: "postgres",
        adapterName: "account-export-no-io",
        connect: async () => {
          throw new Error("Schema inspection must never connect");
        },
      },
    });
    const dmmf = runtimeDmmf.parse(Reflect.get(client, "_runtimeDataModel"));
    const connected = new Set(["User"]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const [name, model] of Object.entries(dmmf.models)) {
        for (const relation of model.fields.filter((field) => field.kind === "object")) {
          if (connected.has(name) || connected.has(relation.type)) {
            if (!connected.has(name) || !connected.has(relation.type)) expanded = true;
            connected.add(name);
            connected.add(relation.type);
          }
        }
      }
    }
    for (const name of connected) {
      expect(
        accountExportModelPolicy[name],
        `Classify new user-linked model ${name} in accountExportModelPolicy and add its safe export or exclusion reason`,
      ).toBeDefined();
      expect(accountExportModelPolicy[name]?.reason.trim().length).toBeGreaterThan(20);
      expect(["exported", "excluded"]).toContain(accountExportModelPolicy[name]?.disposition);
    }
    for (const name of Object.keys(accountExportModelPolicy))
      expect(dmmf.models[name], `Remove stale export policy for ${name}`).toBeDefined();
    // Verification intentionally has no FK. Its proof/state namespaces need an explicit decision too.
    expect(accountExportModelPolicy.Verification?.reason).toContain("proof");
    await client.$disconnect();
  });
});
