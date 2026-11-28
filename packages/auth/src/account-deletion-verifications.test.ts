import type { Prisma } from "@cockpit-chess/db";
import { describe, expect, it, vi } from "vitest";
import { deleteAccountVerifications } from "./account-deletion-verifications.js";

function database() {
  const execute = vi.fn<Prisma.TransactionClient["$executeRaw"]>();
  return { tx: { $executeRaw: execute }, execute };
}

describe("physical account Verification erasure", () => {
  it("returns the committed batch size so a full page cannot become completion", async () => {
    const { tx, execute } = database();
    execute.mockResolvedValueOnce(100).mockResolvedValueOnce(0);
    const user = { id: "owner", email: "Owner@example.com" };
    expect(await deleteAccountVerifications(tx, user)).toBe(100);
    expect(await deleteAccountVerifications(tx, user)).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not turn a failed erasure statement into an empty page", async () => {
    const { tx, execute } = database();
    const unavailable = new Error("database unavailable");
    execute.mockRejectedValue(unavailable);
    await expect(
      deleteAccountVerifications(tx, { id: "owner", email: "owner@example.com" }),
    ).rejects.toBe(unavailable);
  });

  it("binds account identifiers as parameters rather than executable SQL", async () => {
    const { tx, execute } = database();
    execute.mockResolvedValue(0);
    const user = { id: "owner' OR true --", email: "Owner'@example.com" };
    await deleteAccountVerifications(tx, user);
    const call = execute.mock.calls[0];
    if (!call) throw new Error("Expected the physical erasure statement");
    const [statement, ...values] = call;
    if (!Array.isArray(statement)) throw new Error("Expected a tagged SQL statement");
    const sql = statement.join("?");
    expect(sql).not.toContain(user.id);
    expect(sql).not.toContain(user.email);
    expect(values).toContain(user.id);
    expect(values).toContain(user.email.toLowerCase());
  });
});
