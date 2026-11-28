import { isAdminRole } from "@cockpit-chess/auth/roles";
import { Button } from "@cockpit-chess/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-chess/ui/components/card";
import { Input } from "@cockpit-chess/ui/components/input";
import { Label } from "@cockpit-chess/ui/components/label";
import { toast } from "@cockpit-chess/ui/components/sileo";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { TextField } from "@cockpit-chess/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { TwoFactorSetupDetails } from "@/components/two-factor-setup-details";
import { useAuthSession } from "@/hooks/use-auth-session";
import { authClient } from "@/lib/auth-client";
import {
  announceSessionChange,
  isDocumentReplaced,
  leaveDocument,
  markExplicitSignOut,
  subscribeDocumentIdentity,
} from "@/lib/document-identity";
import { signOutAndLeave } from "@/lib/explicit-sign-out";
import {
  type AccountDeletionIssue,
  accountDeletionIssue,
  hasRecentDeletionProof,
} from "@/utils/account-deletion";
import { codeFailureMessage, friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";
import { resolvePasswordChangeErrorMessage } from "@/utils/password-change-error";

export const Route = createFileRoute("/$lang/_app/_auth/settings/security")({
  staticData: { pendingShape: "form" },
  component: SecuritySettings,
});

function SecuritySettings() {
  const { session } = Route.useRouteContext();
  const has2FA = session.user.twoFactorEnabled === true;
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-6">
      <PasswordSection />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {has2FA ? (
              <ShieldCheck className="size-5 text-green-500" />
            ) : (
              <ShieldOff className="size-5 text-muted-foreground" />
            )}
            {t("security.twoFactorTitle")}
          </CardTitle>
          <CardDescription>
            {has2FA ? t("security.enabledDescription") : t("security.disabledDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>{has2FA ? <Disable2FASection /> : <Enable2FASection />}</CardContent>
      </Card>
      <DeleteAccountSection />
    </div>
  );
}

function DeleteAccountSection() {
  const { session: routeSession } = Route.useRouteContext();
  const { lang } = Route.useParams();
  const { t } = useTranslation(["settings", "common"]);
  const authSession = useAuthSession();
  const [open, setOpen] = useState(false);
  const [issue, setIssue] = useState<AccountDeletionIssue | null>(null);
  const [reauthenticating, setReauthenticating] = useState(false);
  const current =
    authSession.state.status === "authenticated" &&
    authSession.state.session.user.id === routeSession.user.id &&
    !authSession.meta.isDegraded
      ? authSession.state.session
      : null;
  const admin = isAdminRole(current?.user.role ?? routeSession.user.role) || issue === "admin";
  const recent = hasRecentDeletionProof(current?.session.authenticatedAt) && issue !== "reauth";
  const deletion = useMutation(
    orpc.settings.deleteAccount.mutationOptions({
      // Acceptance revokes this session. Its explicit identity-boundary load
      // owns navigation, just as the shared sign-out flow does.
      onMutate: () => {
        const undo = markExplicitSignOut();
        let redirected = false;
        const unsubscribe = subscribeDocumentIdentity(() => {
          // A session check can observe revocation before the response arrives.
          // The transport then quarantines its callback. Leave that document
          // with an honest uncertain acknowledgement instead of stranding it.
          if (!redirected && isDocumentReplaced()) {
            redirected = true;
            unsubscribe();
            leaveDocument(`/${lang}/login?accountDeletion=unconfirmed`);
          }
        });
        return { undo, unsubscribe };
      },
      onSuccess: (_result, _input, context) => {
        context?.unsubscribe();
        announceSessionChange();
        leaveDocument(`/${lang}/login?accountDeletion=pending`);
      },
      onError: (error, _input, context) => {
        context?.unsubscribe();
        const nextIssue = accountDeletionIssue(error);
        if (nextIssue === "unavailable") {
          // This refusal follows the durable fence: sessions are already
          // revoked, and background cleanup must retry its external register.
          announceSessionChange();
          leaveDocument(`/${lang}/login?accountDeletion=pending`);
          return;
        }
        context?.undo();
        setIssue(nextIssue);
      },
    }),
  );

  async function reauthenticate() {
    if (deletion.isPending || reauthenticating) return;
    setReauthenticating(true);
    const result = await signOutAndLeave(
      `/${lang}/login?redirectTo=${encodeURIComponent(`/${lang}/settings/security`)}`,
    );
    if (!result.ok) {
      setIssue("unknown");
      setReauthenticating(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings:security.deleteAccountTitle")}</CardTitle>
        <CardDescription>{t("settings:security.deleteAccountDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("settings:security.deleteAccountPlan")}</p>
        <p className="text-sm text-muted-foreground">
          {t("settings:security.deleteAccountProviderKey")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("settings:security.deleteAccountBackups")}
        </p>
        {admin ? (
          <p className="text-sm" role="status">
            {t("settings:security.deleteAccountAdmin")}
          </p>
        ) : !current ? (
          authSession.state.status === "pending" ? (
            <Skeleton className="h-11 w-48" />
          ) : (
            <div className="space-y-2">
              <p className="text-sm">{t("settings:security.deleteAccountSessionCheck")}</p>
              <Button
                type="button"
                variant="outline"
                className="min-h-[44px]"
                onClick={() => void authSession.actions.retry()}
              >
                {t("common:actions.tryAgain")}
              </Button>
            </div>
          )
        ) : !recent ? (
          <>
            <p className="text-sm">{t("settings:security.deleteAccountReauth")}</p>
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px]"
              disabled={reauthenticating}
              onClick={() => void reauthenticate()}
            >
              {reauthenticating
                ? t("settings:security.deleteAccountSigningOut")
                : t("settings:security.deleteAccountSignInAgain")}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="destructive"
            className="min-h-[44px]"
            disabled={deletion.isPending}
            onClick={() => {
              if (!hasRecentDeletionProof(current.session.authenticatedAt)) {
                setIssue("reauth");
                return;
              }
              setIssue(null);
              setOpen(true);
            }}
          >
            {deletion.isPending
              ? t("settings:security.deleteAccountRequesting")
              : t("settings:security.deleteAccountAction")}
          </Button>
        )}
        {issue && issue !== "admin" && issue !== "reauth" ? (
          <p className="text-sm text-destructive" role="alert">
            {t(`settings:security.deleteAccountErrors.${issue}`)}
          </p>
        ) : null}
        <ConfirmDeleteDialog
          open={open}
          onOpenChange={setOpen}
          title={t("settings:security.deleteAccountTitle")}
          description={t("settings:security.deleteAccountConfirmation")}
          confirmToken="DELETE"
          typePrompt={t("settings:security.deleteAccountType")}
          copyAriaLabel={t("settings:security.deleteAccountCopy")}
          inputMode="text"
          confirmLabel={t("settings:security.deleteAccountAction")}
          pendingLabel={t("settings:security.deleteAccountRequesting")}
          isPending={deletion.isPending}
          disabled={!current || !recent || admin}
          onConfirm={(confirmation) => {
            if (confirmation !== "DELETE") return;
            if (!hasRecentDeletionProof(current?.session.authenticatedAt)) {
              setIssue("reauth");
              return;
            }
            setIssue(null);
            deletion.mutate({ confirmation });
          }}
        />
      </CardContent>
    </Card>
  );
}

function PasswordSection() {
  const { t } = useTranslation(["settings", "common"]);
  const {
    data: capabilities,
    isPending,
    isError,
    refetch,
  } = useQuery(orpc.auth.passwordCapabilities.queryOptions());

  if (isPending) {
    return <PasswordCardSkeleton />;
  }

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("settings:security.passwordTitle")}</CardTitle>
          <CardDescription>{t("settings:security.passwordLoadError")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="min-h-[44px]" onClick={() => refetch()}>
            {t("common:actions.tryAgain")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!capabilities.canChangePassword) {
    return null;
  }

  return <ChangePasswordCard />;
}

function PasswordCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
      </CardHeader>
      <CardContent className="max-w-lg space-y-4">
        {["current", "new", "confirm"].map((field) => (
          <div key={field} className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-8 max-md:min-h-11 w-full" />
          </div>
        ))}
        <Skeleton className="h-8 max-md:min-h-11 w-36" />
      </CardContent>
    </Card>
  );
}

function ChangePasswordCard() {
  const { t } = useTranslation(["settings", "validation"]);

  const form = useForm({
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
    validators: {
      onSubmit: z
        .object({
          currentPassword: z.string().min(1),
          newPassword: z.string().min(12).max(128),
          confirmPassword: z.string().min(1),
        })
        .refine((values) => values.newPassword === values.confirmPassword, {
          message: t("validation:passwordsMustMatch"),
          path: ["confirmPassword"],
        }),
    },
    onSubmit: async ({ value }) => {
      try {
        const result = await authClient.changePassword({
          currentPassword: value.currentPassword,
          newPassword: value.newPassword,
          revokeOtherSessions: true,
        });

        if (result.error) {
          toast.error(resolvePasswordChangeErrorMessage(result.error, t));
          return;
        }

        toast.success(t("settings:security.passwordChangedSuccess"));
        form.reset();
      } catch (error) {
        toast.error(resolvePasswordChangeErrorMessage(error, t));
      }
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound aria-hidden="true" className="size-5 text-muted-foreground" />
          {t("settings:security.passwordTitle")}
        </CardTitle>
        <CardDescription>{t("settings:security.passwordDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          <form.Field name="currentPassword">
            {(field) => (
              <TextField
                field={field}
                label={t("settings:security.currentPasswordLabel")}
                type="password"
                autoComplete="current-password"
                inputClassName="autofill:shadow-[inset_0_0_0px_1000px_var(--color-background)]"
              />
            )}
          </form.Field>

          <form.Field name="newPassword">
            {(field) => (
              <TextField
                field={field}
                label={t("settings:security.newPasswordLabel")}
                type="password"
                autoComplete="new-password"
                inputClassName="autofill:shadow-[inset_0_0_0px_1000px_var(--color-background)]"
              />
            )}
          </form.Field>

          <form.Field name="confirmPassword">
            {(field) => (
              <TextField
                field={field}
                label={t("settings:security.confirmPasswordLabel")}
                type="password"
                autoComplete="new-password"
                inputClassName="autofill:shadow-[inset_0_0_0px_1000px_var(--color-background)]"
              />
            )}
          </form.Field>

          <p className="text-sm text-muted-foreground">
            {t("settings:security.passwordSessionRevocation")}
          </p>

          <form.Subscribe
            selector={(state) => ({
              canSubmit: state.canSubmit,
              isSubmitting: state.isSubmitting,
            })}
          >
            {({ canSubmit, isSubmitting }) => (
              <Button type="submit" className="min-h-[44px]" disabled={!canSubmit || isSubmitting}>
                {isSubmitting
                  ? t("settings:security.changingPassword")
                  : t("settings:security.changePassword")}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </CardContent>
    </Card>
  );
}

function Enable2FASection() {
  const [step, setStep] = useState<"idle" | "password" | "setup" | "verify">("idle");
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [verifyCode, setVerifyCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { t } = useTranslation(["settings", "auth", "common"]);

  const handleEnable = async () => {
    setIsLoading(true);
    try {
      const result = await authClient.twoFactor.enable({
        password,
        method: "totp",
      });
      if (result.error) {
        console.error("[settings.security.twoFactor.enable]", result.error);
        toast.error(
          result.error.code === "INVALID_PASSWORD"
            ? t("settings:security.currentPasswordMismatch")
            : friendly(result.error, t("settings:security.couldNotStartSetup")),
        );
        return;
      }
      if (result.data?.method !== "totp") {
        toast.error(t("settings:security.couldNotStartSetup"));
        return;
      }
      setTotpURI(result.data.totpURI || "");
      setBackupCodes(result.data.backupCodes || []);
      setStep("setup");
    } catch (err) {
      console.error("[settings.security.twoFactor.enable]", err);
      // Offline / unreachable say so; anything else keeps the setup copy.
      toast.error(friendly(err, t("settings:security.couldNotStartSetup")));
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerify = async () => {
    setIsLoading(true);
    try {
      const result = await authClient.twoFactor.verifyTotp({
        code: verifyCode,
      });
      if (result.error) {
        console.error("[settings.security.twoFactor.verifyTotp]", result.error);
        // "That code didn't work" only when the code itself was rejected; the
        // typed code stays for a retry either way.
        toast.error(codeFailureMessage(result.error, t("auth:errors.invalidTotp")));
        return;
      }
      toast.success(t("settings:security.enabledSuccess"));
      window.location.reload();
    } catch (err) {
      // The request itself failed (offline, server unreachable): the code was
      // never checked.
      console.error("[settings.security.twoFactor.verifyTotp]", err);
      toast.error(codeFailureMessage(err, t("auth:errors.invalidTotp")));
    } finally {
      setIsLoading(false);
    }
  };

  if (step === "idle") {
    return (
      <Button className="min-h-[44px]" onClick={() => setStep("password")}>
        {t("settings:security.enable2FA")}
      </Button>
    );
  }

  if (step === "password") {
    return (
      <div className="space-y-4 max-w-sm">
        <p className="text-sm text-muted-foreground">
          {t("settings:security.confirmPasswordPrompt")}
        </p>
        <p className="text-sm text-muted-foreground">{t("auth:twoFactor.passwordlessPrompt")}</p>
        <div className="space-y-2">
          <Label htmlFor="confirm-password">{t("auth:fields.password")}</Label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleEnable();
            }}
          />
        </div>
        <div className="flex gap-2">
          <Button className="min-h-[44px]" onClick={handleEnable} disabled={isLoading}>
            {isLoading ? t("auth:twoFactor.settingUp") : t("auth:twoFactor.continue")}
          </Button>
          <Button className="min-h-[44px]" variant="ghost" onClick={() => setStep("idle")}>
            {t("common:actions.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  if (step === "setup") {
    return (
      <div className="space-y-4 max-w-sm">
        <TwoFactorSetupDetails
          backupCodes={backupCodes}
          backupCodesLabel={t("settings:security.saveBackupCodes")}
          manualPrompt={t("settings:security.addKeyToApp")}
          qrPrompt={t("settings:security.scanQrPrompt")}
          totpURI={totpURI}
        />

        <Button className="min-h-[44px]" onClick={() => setStep("verify")}>
          {t("settings:security.savedBackupCodes")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-sm">
      <p className="text-sm text-muted-foreground">{t("settings:security.verifyPrompt")}</p>
      <div className="space-y-2">
        <Label htmlFor="setup-verify-code">{t("auth:fields.verificationCode")}</Label>
        <Input
          id="setup-verify-code"
          placeholder="000000"
          value={verifyCode}
          onChange={(e) => setVerifyCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          className="text-center text-lg tracking-widest"
          onKeyDown={(e) => {
            if (e.key === "Enter" && verifyCode.length === 6) handleVerify();
          }}
        />
      </div>
      <Button
        className="min-h-[44px]"
        onClick={handleVerify}
        disabled={verifyCode.length !== 6 || isLoading}
      >
        {isLoading ? t("auth:twoFactor.verifying") : t("settings:security.verifyAndEnable")}
      </Button>
    </div>
  );
}

function Disable2FASection() {
  const [showConfirm, setShowConfirm] = useState(false);
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { t } = useTranslation(["settings", "auth", "common"]);

  const handleDisable = async () => {
    setIsLoading(true);
    try {
      const result = await authClient.twoFactor.disable({
        password,
      });
      if (result.error) {
        console.error("[settings.security.twoFactor.disable]", result.error);
        toast.error(
          result.error.code === "INVALID_PASSWORD"
            ? t("settings:security.currentPasswordMismatch")
            : friendly(result.error, t("settings:security.couldNotDisable")),
        );
        return;
      }
      toast.success(t("settings:security.disabledSuccess"));
      window.location.reload();
    } catch (err) {
      console.error("[settings.security.twoFactor.disable]", err);
      toast.error(friendly(err, t("settings:security.couldNotDisable")));
    } finally {
      setIsLoading(false);
    }
  };

  if (!showConfirm) {
    return (
      <Button className="min-h-[44px]" variant="outline" onClick={() => setShowConfirm(true)}>
        {t("settings:security.disable2FA")}
      </Button>
    );
  }

  return (
    <div className="space-y-4 max-w-sm">
      <p className="text-sm text-muted-foreground">{t("settings:security.disablePrompt")}</p>
      <div className="space-y-2">
        <Label htmlFor="disable-password">{t("auth:fields.password")}</Label>
        <Input
          id="disable-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleDisable();
          }}
        />
      </div>
      <div className="flex gap-2">
        <Button
          className="min-h-[44px]"
          variant="destructive"
          onClick={handleDisable}
          disabled={!password || isLoading}
        >
          {isLoading ? t("settings:security.disabling") : t("settings:security.disable")}
        </Button>
        <Button className="min-h-[44px]" variant="ghost" onClick={() => setShowConfirm(false)}>
          {t("common:actions.cancel")}
        </Button>
      </div>
    </div>
  );
}
