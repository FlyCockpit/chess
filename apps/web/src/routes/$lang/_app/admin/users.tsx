import { hasRole } from "@cockpit-chess/auth/roles";
import { Button } from "@cockpit-chess/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-chess/ui/components/card";
import { CopyField } from "@cockpit-chess/ui/components/copy-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cockpit-chess/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cockpit-chess/ui/components/dropdown-menu";
import { Input } from "@cockpit-chess/ui/components/input";
import { Label } from "@cockpit-chess/ui/components/label";
import { toast } from "@cockpit-chess/ui/components/sileo";
import { SelectField, TextField } from "@cockpit-chess/ui/components/text-field";
import { useDebounce } from "@cockpit-chess/ui/hooks/use-async-search";
import { cn } from "@cockpit-chess/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Archive, ArchiveArrowUp, MoreVertical, Plus, Send, Shield, Trash } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { RoleChangeDialog, type RoleChangeTarget } from "@/components/admin/role-change-dialog";
import { userChangeErrorKey } from "@/components/admin/user-change-error";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { EmptyState } from "@/components/empty-state";
import { LoadMore } from "@/components/load-more";
import { PageHeader, PageShell } from "@/components/page-shell";
import { QueryBoundary } from "@/components/query-boundary";
import { SegmentedControl } from "@/components/segmented-control";
import { SkeletonList } from "@/components/skeleton-list";
import { announceArchivedWithUndo } from "@/hooks/archive-undo";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { isSupportedLocale, type Locale, SUPPORTED_LOCALES } from "@/i18n/config";
import { LOCALE_LABELS } from "@/i18n/labels";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

type StatusFilter = "all" | "active" | "archived";

const PAGE_LIMIT = 50;

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: string;
  emailVerified: boolean;
  /** Server-computed (users.list): an invite nobody has started using. */
  invitePending: boolean;
  banned: boolean | null;
  banReason: string | null;
  createdAt: Date | string;
};

/** What `users.invite` / `users.resendInvite` return. */
type InviteDelivery =
  | { userId: string; emailSent: true }
  | { userId: string; emailSent: false; setPasswordUrl: string; expiresAt: Date | string };

type InviteReveal = { email: string; setPasswordUrl: string; expiresAt: Date | string };

/** `users.resendInvite` refused: the user is not (or no longer) a pending invite. */
function isInviteNotPending(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "INVITE_NOT_PENDING"
  );
}

function buildInviteSchema() {
  return z.object({
    email: z.email(),
    name: z.string().trim().min(1).max(100),
    role: z.enum(["user", "admin"]),
    locale: z.enum(SUPPORTED_LOCALES),
  });
}

export const Route = createFileRoute("/$lang/_app/admin/users")({
  staticData: { pendingShape: "list", pendingWidth: "wide" },
  component: AdminUsers,
});

function AdminUsers() {
  const { session } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const { t } = useTranslation(["admin", "common"]);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [reveal, setReveal] = useState<InviteReveal | null>(null);
  // Captured when the dialog opens, not looked up in the loaded pages: a
  // refetch, filter change or search that drops the row must not blank the
  // confirm token (or retarget the delete) while the dialog is up.
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; email: string } | null>(null);
  const [roleTarget, setRoleTarget] = useState<RoleChangeTarget | null>(null);
  const debouncedSearch = useDebounce(search.trim(), 300);

  const listQuery = useInfiniteQuery(
    orpc.users.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        limit: PAGE_LIMIT,
        cursor,
        search: debouncedSearch || undefined,
        status: statusFilter,
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }),
  );

  const setRole = useEntityMutation(
    {
      ...orpc.users.setRole.mutationOptions({
        onSuccess: () => setRoleTarget(null),
      }),
      meta: { skipGlobalErrorToast: true },
    },
    { invalidateKey: orpc.users.key(), successMessage: t("admin:users.roleUpdated") },
  );

  const unarchive = useEntityMutation(
    {
      ...orpc.users.unarchive.mutationOptions(),
      meta: { errorFallbackKey: "admin:users.restoreFailed" },
    },
    { invalidateKey: orpc.users.key(), successMessage: t("admin:users.userRestored") },
  );

  // Archive acts at once (it is fully reversible); its toast offers Undo,
  // which is the row's Restore (users.unarchive).
  const archive = useMutation({
    ...orpc.users.archive.mutationOptions({
      onSuccess: (_data, variables) => {
        announceArchivedWithUndo({
          message: t("admin:users.userArchived"),
          undoLabel: t("common:actions.undo"),
          onUndo: () => {
            unarchive.mutate({ userId: variables.userId });
          },
        });
        void queryClient.invalidateQueries({ queryKey: orpc.users.key() });
      },
      onError: (error) => {
        const key = userChangeErrorKey(error);
        toast.error(key ? t(key) : friendly(error, t("admin:users.archiveFailed")));
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });

  const remove = useMutation({
    ...orpc.users.remove.mutationOptions({
      onSuccess: () => {
        setDeleteTarget(null);
        toast.success(t("admin:users.userDeleted"));
        void queryClient.invalidateQueries({ queryKey: orpc.users.key() });
      },
      onError: (error) => {
        const key = userChangeErrorKey(error);
        toast.error(key ? t(key) : friendly(error, t("admin:users.deleteFailed")));
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });

  const resendInvite = useMutation({
    ...orpc.users.resendInvite.mutationOptions({
      onError: (error) => {
        // The row was stale: the user started using the account (or links
        // SSO) since the list loaded. Say so and refresh, so the action goes.
        if (isInviteNotPending(error)) {
          toast.error(t("admin:users.inviteNotPending"));
          void queryClient.invalidateQueries({ queryKey: orpc.users.key() });
          return;
        }
        toast.error(friendly(error, t("admin:users.resendFailed")));
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });

  // Both invite paths end here. An emailed link stays in the invitee's inbox;
  // only a link the server could not email comes back, for a one-time reveal.
  const handleInviteDelivery = (delivery: InviteDelivery, email: string) => {
    if (delivery.emailSent) {
      toast.success(t("admin:users.inviteSent", { email }));
    } else {
      setReveal({ email, setPasswordUrl: delivery.setPasswordUrl, expiresAt: delivery.expiresAt });
    }
    void queryClient.invalidateQueries({ queryKey: orpc.users.key() });
  };

  // Status is filtered server-side (see users.list), so every loaded row
  // already matches the active tab. Emptiness and pagination are decided on the
  // server result, never on a client-side slice of the pages we happen to hold.
  const allUsers = (listQuery.data?.pages.flatMap((page) => page.users) ?? []) as UserRow[];
  // One row change at a time: a second click on a stale row while the first
  // mutation is in flight would act on what the list showed before it.
  const rowActionPending =
    setRole.isPending || archive.isPending || unarchive.isPending || resendInvite.isPending;
  // Stable reasons carry expected refusals across locales. Never display the
  // server's English message for a permission, missing target, or retry error.
  const roleErrorKey = userChangeErrorKey(setRole.error);
  const roleError = setRole.error
    ? roleErrorKey
      ? t(roleErrorKey)
      : friendly(setRole.error, t("admin:users.roleUpdateFailed"))
    : undefined;

  return (
    <PageShell width="wide">
      <PageHeader
        title={t("admin:users.title")}
        description={t("admin:users.description")}
        actions={
          <Button
            onClick={() => {
              setInviteOpen(true);
            }}
            className="min-h-[44px]"
          >
            <Plus className="size-4" /> {t("admin:users.invite")}
          </Button>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          value={statusFilter}
          onChange={setStatusFilter}
          items={[
            { value: "all", label: t("admin:users.tabAll") },
            { value: "active", label: t("admin:users.tabActive") },
            { value: "archived", label: t("admin:users.tabArchived") },
          ]}
        />
        <Input
          type="search"
          inputMode="search"
          autoComplete="off"
          placeholder={t("admin:users.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-xs"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("admin:users.allUsers")}</CardTitle>
          <CardDescription>
            {listQuery.isPending
              ? t("admin:users.loading")
              : listQuery.isError
                ? t("admin:users.loadFailedShort")
                : t("admin:users.shownCount", {
                    count: allUsers.length,
                    shown: allUsers.length,
                  })}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <QueryBoundary
            query={listQuery}
            skeleton={<SkeletonList count={6} />}
            errorMessage={t("admin:users.loadFailed")}
            errorClassName="py-12"
            isEmpty={(data) => data.pages.every((page) => page.users.length === 0)}
            empty={
              <EmptyState
                title={
                  search.trim()
                    ? t("admin:users.noMatch")
                    : statusFilter === "archived"
                      ? t("admin:users.noArchived")
                      : statusFilter === "active"
                        ? t("admin:users.noActive")
                        : t("admin:users.noUsersYet")
                }
                description={
                  search.trim() ? t("admin:users.tryDifferentQuery") : t("admin:users.inviteFirst")
                }
              />
            }
          >
            {() => (
              <>
                <ul className="divide-y">
                  {/* `allUsers` is the same flattened pages QueryBoundary just
                      vouched for — flattened once, above. */}
                  {allUsers.map((user) => {
                    const isSelf = user.id === session.user.id;
                    const isAdmin = hasRole(user.role, "admin");
                    const isArchived = !!user.banned;
                    return (
                      <li
                        key={user.id}
                        className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 sm:items-center"
                      >
                        {/* The actions stay beside the name; they drop below it only
                            when the name column would go under 12rem (a large
                            browser font size on a phone). */}
                        <div className="min-w-0 grow basis-48">
                          <p className="flex flex-wrap items-center gap-2 font-medium">
                            <span className="truncate">{user.name || user.email}</span>
                            {isSelf && (
                              <span className="rounded-full border bg-muted px-1.5 py-0.5 text-xs font-medium uppercase text-muted-foreground">
                                {t("admin:users.youBadge")}
                              </span>
                            )}
                            <RolePill isAdmin={isAdmin} />
                            {isArchived && <ArchivedPill />}
                            {!user.emailVerified && <UnverifiedPill />}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {user.email} · {t("admin:users.joined")}{" "}
                            <time dateTime={new Date(user.createdAt).toISOString()}>
                              {new Date(user.createdAt).toLocaleDateString()}
                            </time>
                            {user.banReason ? ` · ${user.banReason}` : ""}
                          </p>
                        </div>
                        <UserActions
                          user={user}
                          isSelf={isSelf}
                          isAdmin={isAdmin}
                          isArchived={isArchived}
                          disabled={rowActionPending}
                          onSetRole={(role) => {
                            setRole.reset();
                            setRoleTarget({
                              id: user.id,
                              name: user.name,
                              email: user.email,
                              role,
                            });
                          }}
                          onArchive={() => {
                            archive.mutate({ userId: user.id });
                          }}
                          onUnarchive={() => {
                            unarchive.mutate({ userId: user.id });
                          }}
                          onResendInvite={() => {
                            resendInvite.mutate(
                              { userId: user.id },
                              {
                                onSuccess: (delivery) => handleInviteDelivery(delivery, user.email),
                              },
                            );
                          }}
                          onDelete={() => {
                            setDeleteTarget({ id: user.id, email: user.email });
                          }}
                        />
                      </li>
                    );
                  })}
                </ul>
                <LoadMore
                  hasNextPage={listQuery.hasNextPage}
                  isFetchingNextPage={listQuery.isFetchingNextPage}
                  onLoadMore={() => void listQuery.fetchNextPage()}
                />
              </>
            )}
          </QueryBoundary>
        </CardContent>
      </Card>

      <InviteUserDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={(delivery, email) => {
          setInviteOpen(false);
          handleInviteDelivery(delivery, email);
        }}
      />

      <RevealInviteDialog reveal={reveal} onClose={() => setReveal(null)} />

      <RoleChangeDialog
        target={roleTarget}
        isPending={setRole.isPending}
        error={roleError}
        onClose={() => setRoleTarget(null)}
        onConfirm={() => {
          if (!roleTarget) return;
          setRole.mutate({ userId: roleTarget.id, role: roleTarget.role });
        }}
      />

      <ConfirmDeleteDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("admin:users.deleteTitle")}
        description={t("admin:users.deleteDescription")}
        confirmToken={deleteTarget?.email ?? ""}
        typePrompt={t("admin:users.typeEmailToConfirm")}
        copyAriaLabel={t("admin:users.copyEmailAriaLabel")}
        inputMode="email"
        isPending={remove.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          remove.mutate({ userId: deleteTarget.id });
        }}
      />
    </PageShell>
  );
}

function UserActions({
  user,
  isSelf,
  isAdmin,
  isArchived,
  disabled,
  onSetRole,
  onArchive,
  onUnarchive,
  onResendInvite,
  onDelete,
}: {
  user: UserRow;
  isSelf: boolean;
  isAdmin: boolean;
  isArchived: boolean;
  /** A row mutation is in flight; every item waits for it. */
  disabled: boolean;
  onSetRole: (role: "user" | "admin") => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onResendInvite: () => void;
  onDelete: () => void;
}) {
  // The server decides what a pending invite is (unverified, password account
  // only, never signed in) and enforces it again on resend. `emailVerified`
  // alone is not it: an active SSO user can be unverified.
  const invitePending = user.invitePending && !isArchived;
  const { t } = useTranslation("admin");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="min-h-[44px] min-w-11 shrink-0"
            aria-label={t("users.actionsAriaLabel", { name: user.name || user.email })}
          />
        }
      >
        <MoreVertical aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {invitePending && (
          <DropdownMenuItem disabled={disabled} onClick={onResendInvite}>
            <Send className="size-4" />
            {t("users.resendInvite")}
          </DropdownMenuItem>
        )}
        {isAdmin ? (
          <DropdownMenuItem disabled={isSelf || disabled} onClick={() => onSetRole("user")}>
            <Shield className="size-4" />
            {t("users.demoteToUser")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={disabled} onClick={() => onSetRole("admin")}>
            <Shield className="size-4" />
            {t("users.promoteToAdmin")}
          </DropdownMenuItem>
        )}
        {isArchived ? (
          <DropdownMenuItem disabled={disabled} onClick={onUnarchive}>
            <ArchiveArrowUp className="size-4" />
            {t("users.restoreUser")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled={isSelf || disabled} onClick={onArchive}>
            <Archive className="size-4" />
            {t("users.archiveUser")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={isSelf || disabled} onClick={onDelete}>
          <Trash className="size-4" />
          {t("users.deleteAction")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RolePill({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation("admin");
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium uppercase",
        isAdmin
          ? "bg-violet-500/10 text-violet-700 dark:text-violet-400"
          : "bg-muted text-muted-foreground",
      )}
    >
      {isAdmin ? t("users.adminBadge") : t("users.userBadge")}
    </span>
  );
}

function ArchivedPill() {
  const { t } = useTranslation("admin");
  return (
    <span className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium uppercase text-amber-700 dark:text-amber-400">
      {t("users.archivedBadge")}
    </span>
  );
}

function UnverifiedPill() {
  const { t } = useTranslation("admin");
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium uppercase text-muted-foreground">
      {t("users.unverifiedBadge")}
    </span>
  );
}

function InviteUserDialog({
  open,
  onOpenChange,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onInvited: (delivery: InviteDelivery, email: string) => void;
}) {
  const { t, i18n } = useTranslation(["admin", "common"]);
  // The invitee's language defaults to the admin's own; the admin changes it
  // when the invitee reads another one.
  const adminLocale: Locale = isSupportedLocale(i18n.language) ? i18n.language : "en-US";
  const invite = useMutation({
    ...orpc.users.invite.mutationOptions(),
    meta: { errorFallbackKey: "admin:users.inviteFailed" },
  });

  const form = useForm({
    defaultValues: {
      email: "",
      name: "",
      role: "user" as "user" | "admin",
      locale: adminLocale,
    },
    validators: { onChange: buildInviteSchema() },
    onSubmit: async ({ value }) => {
      const delivery = await invite.mutateAsync(value);
      onInvited(delivery, value.email.toLowerCase());
      form.reset();
    },
  });

  // The one close path for Escape, backdrop, X and Cancel: an invite in flight
  // can't be abandoned, and every close starts the next open from a blank form.
  const handleOpenChange = (next: boolean) => {
    if (invite.isPending) return;
    if (!next) form.reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin:users.inviteTitle")}</DialogTitle>
          <DialogDescription>{t("admin:users.inviteDescription")}</DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
          className="space-y-3"
        >
          <form.Field name="name">
            {(field) => (
              <TextField
                field={field}
                label={t("admin:users.nameLabel")}
                inputMode="text"
                autoComplete="name"
                className="space-y-1.5"
              />
            )}
          </form.Field>

          <form.Field name="email">
            {(field) => (
              <TextField
                field={field}
                label={t("admin:users.emailLabel")}
                type="email"
                autoComplete="email"
                placeholder={t("admin:users.emailPlaceholder")}
                className="space-y-1.5"
              />
            )}
          </form.Field>

          <form.Field name="role">
            {(field) => (
              <SelectField
                field={field}
                label={t("admin:users.roleLabel")}
                className="space-y-1.5"
                options={[
                  { value: "user", label: t("admin:users.roleUser") },
                  { value: "admin", label: t("admin:users.roleAdmin") },
                ]}
              />
            )}
          </form.Field>

          <form.Field name="locale">
            {(field) => (
              <SelectField
                field={field}
                label={t("admin:users.localeLabel")}
                description={t("admin:users.localeDescription")}
                className="space-y-1.5"
                options={SUPPORTED_LOCALES.map((locale) => ({
                  value: locale,
                  label: LOCALE_LABELS[locale],
                }))}
              />
            )}
          </form.Field>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              className="min-h-[44px]"
              onClick={() => handleOpenChange(false)}
              disabled={invite.isPending}
            >
              {t("common:actions.cancel")}
            </Button>
            <form.Subscribe selector={(s) => [s.canSubmit, s.isSubmitting] as const}>
              {([canSubmit, isSubmitting]) => (
                <Button
                  type="submit"
                  className="min-h-[44px]"
                  disabled={!canSubmit || isSubmitting || invite.isPending}
                >
                  {isSubmitting || invite.isPending
                    ? t("admin:users.inviting")
                    : t("admin:users.sendInvite")}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RevealInviteDialog({
  reveal,
  onClose,
}: {
  reveal: InviteReveal | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation(["admin", "common", "errors"]);
  const expires = reveal
    ? new Date(reveal.expiresAt).toLocaleString(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";
  return (
    // One-time reveal (patterns/overlays.md): the set-password link is never
    // shown again, so Escape and backdrop requests are ignored and the X is
    // hidden. Only the explicit Done button closes the dialog.
    <Dialog open={!!reveal} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("admin:users.revealTitle", { email: reveal?.email ?? "" })}</DialogTitle>
          <DialogDescription>{t("admin:users.revealDescription")}</DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-1.5">
          <Label>{t("admin:users.setPasswordLinkLabel")}</Label>
          <CopyField
            value={reveal?.setPasswordUrl ?? ""}
            copyLabel={t("admin:users.copySetPasswordLinkAriaLabel")}
            onCopied={() => toast.success(t("admin:users.linkCopied"))}
            onCopyError={() => toast.error(t("errors:couldNotCopy"))}
          />
          <p className="text-xs text-muted-foreground">
            {t("admin:users.setPasswordLinkHint", { date: expires })}
          </p>
        </div>

        <DialogFooter>
          <Button onClick={onClose} className="min-h-[44px]">
            {t("admin:users.savedLink")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
