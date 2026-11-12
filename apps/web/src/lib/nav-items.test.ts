import { describe, expect, it } from "vitest";

import { getNavItems, toLangRoute } from "./nav-items";

describe("nav-items", () => {
  it("returns public desktop items for signed-out visitors", () => {
    const items = getNavItems({
      placement: "desktop",
      isAuthenticated: false,
    }).map((item) => item.path);

    expect(items).toEqual(["/"]);
  });

  it("keeps public desktop items and adds app items for signed-in users", () => {
    const items = getNavItems({
      placement: "desktop",
      isAuthenticated: true,
      role: "user",
    }).map((item) => item.path);

    expect(items).toEqual(["/", "/dashboard", "/settings"]);
    expect(items).not.toContain("/admin");
  });

  it("adds admin destinations only when the shared admin role helper matches", () => {
    const nonAdminItems = getNavItems({
      placement: "desktop",
      isAuthenticated: true,
      role: "manager",
    }).map((item) => item.path);
    const adminItems = getNavItems({
      placement: "desktop",
      isAuthenticated: true,
      role: "user, admin",
    }).map((item) => item.path);

    expect(nonAdminItems).not.toContain("/admin");
    expect(adminItems).toContain("/admin");
  });

  it("keeps mobile navigation compact and role-aware", () => {
    const signedOutItems = getNavItems({
      placement: "mobile",
      isAuthenticated: false,
    }).map((item) => item.path);
    const adminItems = getNavItems({
      placement: "mobile",
      isAuthenticated: true,
      role: "admin",
    }).map((item) => item.path);

    expect(signedOutItems).toEqual(["/"]);
    expect(adminItems).toEqual(["/", "/dashboard", "/settings", "/admin"]);
  });

  it("derives user-menu destinations from the shared nav model", () => {
    const userItems = getNavItems({
      placement: "userMenu",
      isAuthenticated: true,
      role: "user",
    }).map((item) => item.path);
    const adminItems = getNavItems({
      placement: "userMenu",
      isAuthenticated: true,
      role: "admin",
    }).map((item) => item.path);

    expect(userItems).toEqual(["/settings"]);
    expect(adminItems).toEqual(["/settings", "/admin"]);
  });

  it("builds typed locale-prefixed routes", () => {
    expect(toLangRoute("/")).toBe("/$lang");
    expect(toLangRoute("/dashboard")).toBe("/$lang/dashboard");
  });
});
