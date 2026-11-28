import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  role: "user",
  state: {
    status: "authenticated",
    session: {
      user: { id: "owner", role: "user" },
      session: { authenticatedAt: new Date(), createdAt: new Date() },
    },
  },
  degraded: false,
  mutate: vi.fn(),
  retry: vi.fn(),
  undo: vi.fn(),
  unsubscribe: vi.fn(),
  replaced: false,
  identityListener: null as (() => void) | null,
  leaveDocument: vi.fn(),
  announceSessionChange: vi.fn(),
  signOutAndLeave: vi.fn(),
  mutation: null as {
    onMutate(): { undo(): void; unsubscribe(): void };
    onSuccess(): void;
    onError(error: unknown, input: unknown, context?: { undo(): void; unsubscribe(): void }): void;
  } | null,
  dialog: null as {
    confirmToken: string;
    disabled: boolean;
    onConfirm(confirmation: string): void;
  } | null,
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { canChangePassword: false }, isPending: false, isError: false }),
  useMutation: (options: NonNullable<typeof fixture.mutation>) => {
    fixture.mutation = options;
    return { mutate: fixture.mutate, isPending: false };
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
    useRouteContext: () => ({
      session: { user: { id: "owner", role: fixture.role } },
    }),
  }),
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: fixture.state,
    meta: { isDegraded: fixture.degraded },
    actions: { retry: fixture.retry },
  }),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: {} }));
vi.mock("@/lib/document-identity", () => ({
  markExplicitSignOut: () => fixture.undo,
  leaveDocument: fixture.leaveDocument,
  announceSessionChange: fixture.announceSessionChange,
  isDocumentReplaced: () => fixture.replaced,
  subscribeDocumentIdentity: (listener: () => void) => {
    fixture.identityListener = listener;
    return fixture.unsubscribe;
  },
}));
vi.mock("@/lib/explicit-sign-out", () => ({ signOutAndLeave: fixture.signOutAndLeave }));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    auth: { passwordCapabilities: { queryOptions: () => ({}) } },
    settings: { deleteAccount: { mutationOptions: (options: unknown) => options } },
  },
}));
vi.mock("@/components/confirm-delete-dialog", () => ({
  ConfirmDeleteDialog: (props: NonNullable<typeof fixture.dialog>) => {
    fixture.dialog = props;
    return null;
  },
}));

import { Route } from "./security";

async function render() {
  const Component = Route.options.component;
  if (!Component) throw new Error("Missing security component");
  await Component.preload?.();
  return renderToStaticMarkup(createElement(Component));
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.role = "user";
  fixture.state.status = "authenticated";
  fixture.state.session.user.role = "user";
  fixture.state.session.session.authenticatedAt = new Date();
  fixture.state.session.session.createdAt = new Date();
  fixture.degraded = false;
  fixture.dialog = null;
  fixture.mutation = null;
  fixture.replaced = false;
  fixture.identityListener = null;
});

describe("account deletion settings", () => {
  it("guides a recent genuine sign-in through typed confirmation and explains retention", async () => {
    const html = await render();
    expect(html).toContain("deleteAccountAction");
    expect(html).toContain("deleteAccountPlan");
    expect(html).toContain("deleteAccountProviderKey");
    expect(html).toContain("deleteAccountBackups");
    expect(fixture.dialog?.confirmToken).toBe("DELETE");
    expect(fixture.dialog?.disabled).toBe(false);
    fixture.dialog?.onConfirm("DELETE");
    expect(fixture.mutate).toHaveBeenCalledWith({ confirmation: "DELETE" });
  });

  it("never treats fresh session creation as fresh primary authentication", async () => {
    fixture.state.session.session.authenticatedAt = new Date(Date.now() - 300_001);
    const html = await render();
    expect(html).toContain("deleteAccountReauth");
    expect(html).toContain("deleteAccountSignInAgain");
    expect(html).not.toContain("deleteAccountAction");
    expect(fixture.dialog?.disabled).toBe(true);
  });

  it("refuses stale proof at the final confirm even when the dialog was already open", async () => {
    await render();
    fixture.state.session.session.authenticatedAt = new Date(Date.now() - 300_001);
    fixture.dialog?.onConfirm("DELETE");
    expect(fixture.mutate).not.toHaveBeenCalled();
  });

  it("requires administrators to transfer authority before offering deletion", async () => {
    fixture.role = "admin";
    fixture.state.session.user.role = "admin";
    const html = await render();
    expect(html).toContain("deleteAccountAdmin");
    expect(html).not.toContain("deleteAccountAction");
    expect(fixture.dialog?.disabled).toBe(true);
  });

  it("keeps a bounded control skeleton while genuine session proof is loading", async () => {
    fixture.state.status = "pending";
    const html = await render();
    expect(html).toContain("h-11 w-48");
    expect(html).not.toContain("deleteAccountAction");
    expect(fixture.dialog?.disabled).toBe(true);
  });

  it("offers a session retry after a proof check fails without inventing proof", async () => {
    fixture.state.status = "error";
    const html = await render();
    expect(html).toContain("deleteAccountSessionCheck");
    expect(html).toContain("common:actions.tryAgain");
    expect(html).not.toContain("deleteAccountAction");
    expect(fixture.dialog?.disabled).toBe(true);
  });

  it("quarantines the old identity into a fixed pending acknowledgement after acceptance", async () => {
    await render();
    fixture.mutation?.onSuccess();
    expect(fixture.announceSessionChange).toHaveBeenCalledOnce();
    expect(fixture.leaveDocument).toHaveBeenCalledWith("/en-US/login?accountDeletion=pending");
  });

  it("releases the explicit sign-out ownership after a refused request", async () => {
    await render();
    const context = fixture.mutation?.onMutate();
    fixture.mutation?.onError({ data: { reason: "REAUTH_REQUIRED" } }, {}, context);
    expect(fixture.undo).toHaveBeenCalledOnce();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.leaveDocument).not.toHaveBeenCalled();
  });

  it("keeps the accepted pending acknowledgement when suppression storage fails after fencing", async () => {
    await render();
    const context = fixture.mutation?.onMutate();
    fixture.mutation?.onError({ data: { reason: "CLEANUP_UNAVAILABLE" } }, {}, context);
    expect(fixture.undo).not.toHaveBeenCalled();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.leaveDocument).toHaveBeenCalledWith("/en-US/login?accountDeletion=pending");
    expect(fixture.announceSessionChange).toHaveBeenCalledOnce();
  });

  it("leaves a quarantined document if session revocation wins the race against the response", async () => {
    await render();
    fixture.mutation?.onMutate();
    fixture.identityListener?.();
    expect(fixture.leaveDocument).not.toHaveBeenCalled();
    fixture.replaced = true;
    fixture.identityListener?.();
    fixture.identityListener?.();
    expect(fixture.leaveDocument).toHaveBeenCalledWith("/en-US/login?accountDeletion=unconfirmed");
    expect(fixture.leaveDocument).toHaveBeenCalledOnce();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
    expect(fixture.undo).not.toHaveBeenCalled();
  });
});
