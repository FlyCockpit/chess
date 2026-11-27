import { Button, buttonVariants } from "@cockpit-chess/ui/components/button";
import { Input } from "@cockpit-chess/ui/components/input";
import { Label } from "@cockpit-chess/ui/components/label";
import { toast } from "@cockpit-chess/ui/components/sileo";
import { TextField } from "@cockpit-chess/ui/components/text-field";
import { cn } from "@cockpit-chess/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AuthConfigGate } from "@/components/auth/auth-config-gate";
import { AuthCard } from "@/components/auth/auth-screen";
import { useAuthSession } from "@/hooks/use-auth-session";
import { usePeerSessionChange } from "@/hooks/use-peer-session-change";
import { APP_HOME, appHomeHref } from "@/lib/app-home";
import { authClient } from "@/lib/auth-client";
import { resolveRouteSession } from "@/lib/route-session";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { setSessionHint } from "@/lib/session-hint";
import {
  codeFailureMessage,
  friendly,
  isRateLimit,
  signInFailureMessage,
} from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";
import { safeRedirectTo } from "@/utils/safe-redirect";

export const Route = createFileRoute("/$lang/_app/login")({
  staticData: { pendingShape: "form", pendingWidth: "narrow" },
  validateSearch: (search: Record<string, unknown>) => ({
    redirectTo: typeof search.redirectTo === "string" ? search.redirectTo : undefined,
  }),
  beforeLoad: async ({ params, search }) => {
    const decision = decideAnonymousOnlyRouteAccess(await resolveRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-authenticated") {
      throw redirect({ href: safeRedirectTo(search.redirectTo, params.lang) });
    }
  },
  component: LoginPage,
});

/**
 * The whole 2FA challenge as one state object (rather than five separate
 * `useState` calls) so a step change — entering the challenge, sending an
 * email code, or backing out — is a single update and a single render, with
 * no way for the pieces to drift apart mid-transition.
 *
 * `otpSent` marks the email-OTP path: once the user requests a code by email
 * we verify against verifyOtp instead of verifyTotp.
 */
const initialTwoFactorState = {
  active: false,
  code: "",
  verifying: false,
  otpSent: false,
  sendingOtp: false,
};

function LoginPage() {
  const { lang } = Route.useParams();
  const { redirectTo } = Route.useSearch();
  const [twoFactor, setTwoFactor] = useState(initialTwoFactorState);
  const authSession = useAuthSession();
  // Another tab signed in: re-run this page's guard, which sends a signed-in
  // visitor on (`redirect-authenticated`) instead of leaving the form up
  // beside the new account's menu.
  const router = useRouter();
  usePeerSessionChange(useCallback(() => void router.invalidate(), [router]));
  const {
    data: configData,
    isPending: configPending,
    // Only a first load that failed: a failed background refetch (refocus,
    // reconnect) keeps the loaded config and the form with what was typed.
    isLoadingError: configError,
    refetch: refetchConfig,
  } = useQuery(orpc.appConfig.queryOptions());
  const { t } = useTranslation(["auth", "common"]);

  const ssoEnabled = configData?.ssoEnabled ?? false;
  const forceSso = configData?.forceSso === true;
  const ssoProviderName = configData?.ssoProviderName ?? "SSO";
  const signupEnabled =
    !forceSso &&
    ((configData?.signupEnabled ?? true) || configData?.adminBootstrapSignupEnabled === true);
  const emailEnabled = configData?.emailEnabled ?? false;
  const postAuthRedirect = safeRedirectTo(redirectTo, lang);
  const sessionPending =
    authSession.state.status === "pending" || authSession.state.status === "error";

  const handleSsoLogin = async () => {
    const result = await authClient.signIn.social({
      provider: "sso",
      // Back through this page's guard, which confirms (and announces to the
      // other tabs) the new identity before forwarding: the destination
      // itself may run no session check at all.
      callbackURL: `/${lang}/login?redirectTo=${encodeURIComponent(postAuthRedirect)}`,
    });
    if (result.error) {
      console.error("[login.sso]", result.error);
      toast.error(t("auth:login.ssoFailed"));
    }
  };

  const handle2FAVerify = async () => {
    // Enter and the button both land here; one verification at a time.
    if (twoFactor.verifying) return;
    setTwoFactor((s) => ({ ...s, verifying: true }));
    try {
      // When the user requested an emailed code we verify against the OTP
      // endpoint; otherwise the code is a TOTP from their authenticator app.
      const result = twoFactor.otpSent
        ? await authClient.twoFactor.verifyOtp({ code: twoFactor.code })
        : await authClient.twoFactor.verifyTotp({ code: twoFactor.code });
      if (result.error) {
        console.error("[login.twoFactor.verify]", result.error);
        // "That code didn't work" only when the code itself was rejected; a
        // server, network or rate-limit failure says so. The code stays as
        // typed either way, so the same one can be sent again.
        toast.error(codeFailureMessage(result.error, t("auth:errors.invalidTotp")));
      } else {
        toast.success(t("auth:signedInSuccess"));
        window.location.assign(postAuthRedirect);
      }
    } catch (err) {
      // The request itself failed (offline, server unreachable).
      console.error("[login.twoFactor.verify]", err);
      toast.error(codeFailureMessage(err, t("auth:errors.invalidTotp")));
    } finally {
      setTwoFactor((s) => ({ ...s, verifying: false }));
    }
  };

  const handleSendEmailOtp = async () => {
    setTwoFactor((s) => ({ ...s, sendingOtp: true }));
    try {
      // Delivery-aware preflight: Better-Auth's send-otp endpoint reports
      // success even when SMTP delivery fails, so verify the transport is
      // actually reachable before telling the user a code is on the way.
      const preflight = await orpc.auth.verifyEmailTransport.call().catch((err) => {
        console.error("[login.twoFactor.verifyEmailTransport]", err);
        return { ok: false };
      });
      if (!preflight.ok) {
        toast.error(t("auth:twoFactor.couldNotSendCode"));
        return;
      }
      const result = await authClient.twoFactor.sendOtp();
      if (result.error) {
        console.error("[login.twoFactor.sendOtp]", result.error);
        toast.error(
          isRateLimit(result.error) ? friendly(result.error) : t("auth:twoFactor.couldNotSendCode"),
        );
        return;
      }
      setTwoFactor((s) => ({ ...s, otpSent: true, code: "" }));
      toast.success(t("auth:twoFactor.codeSent"));
    } catch (err) {
      // The request itself failed (offline, server unreachable).
      console.error("[login.twoFactor.sendOtp]", err);
      toast.error(friendly(err, t("auth:twoFactor.couldNotSendCode")));
    } finally {
      setTwoFactor((s) => ({ ...s, sendingOtp: false }));
    }
  };

  return (
    <AuthConfigGate
      isPending={sessionPending || configPending}
      isError={configError}
      onRetry={() => refetchConfig()}
    >
      {twoFactor.active ? (
        <AuthCard
          title={t("auth:twoFactor.title")}
          description={
            twoFactor.otpSent
              ? t("auth:twoFactor.emailCodeDescription")
              : t("auth:twoFactor.description")
          }
        >
          <div className="space-y-2">
            <Label htmlFor="totp-code">{t("auth:fields.verificationCode")}</Label>
            <Input
              id="totp-code"
              placeholder="000000"
              value={twoFactor.code}
              onChange={(e) => setTwoFactor((s) => ({ ...s, code: e.target.value }))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="text-center text-lg tracking-widest"
              onKeyDown={(e) => {
                if (e.key === "Enter" && twoFactor.code.length === 6) {
                  handle2FAVerify();
                }
              }}
            />
          </div>
          <Button
            className="min-h-[44px] w-full"
            onClick={handle2FAVerify}
            disabled={twoFactor.code.length !== 6 || twoFactor.verifying}
          >
            {twoFactor.verifying ? t("auth:twoFactor.verifying") : t("auth:twoFactor.verify")}
          </Button>
          {emailEnabled && (
            <Button
              variant="outline"
              className="min-h-[44px] w-full"
              onClick={handleSendEmailOtp}
              disabled={twoFactor.sendingOtp}
            >
              {twoFactor.sendingOtp
                ? t("auth:twoFactor.sendingCode")
                : twoFactor.otpSent
                  ? t("auth:twoFactor.resendEmailCode")
                  : t("auth:twoFactor.emailMeCode")}
            </Button>
          )}
          <Button
            variant="ghost"
            className="min-h-[44px] w-full"
            onClick={() => setTwoFactor(initialTwoFactorState)}
          >
            {t("auth:twoFactor.back")}
          </Button>
        </AuthCard>
      ) : (
        <AuthCard
          title={t("auth:login.signinTitle")}
          description={
            forceSso
              ? t("auth:login.ssoOnlyDescription", { provider: ssoProviderName })
              : t("auth:login.signinDescription")
          }
        >
          {ssoEnabled && (
            <>
              <Button variant="outline" className="min-h-[44px] w-full" onClick={handleSsoLogin}>
                {t("auth:login.ssoContinue", { provider: ssoProviderName })}
              </Button>
              {!forceSso && (
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">{t("auth:login.or")}</span>
                  </div>
                </div>
              )}
            </>
          )}
          {!forceSso && (
            <SignInForm
              lang={lang}
              redirectTo={postAuthRedirect}
              showForgotPassword={emailEnabled}
              onNeeds2FA={() => setTwoFactor({ ...initialTwoFactorState, active: true })}
            />
          )}
          {forceSso && !ssoEnabled && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {t("auth:login.ssoUnavailable")}
            </div>
          )}
          {signupEnabled && (
            // `max-sm:-mt-2`: on phones the link's 44px box may use half of the
            // gap above it (its text sits 12px inside the box), which helps
            // keep it above a first visit's cookie banner (docs/design-system.md).
            <div className="text-center max-sm:-mt-2">
              <Link
                to="/$lang/signup"
                params={{ lang }}
                search={{ redirectTo }}
                className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
              >
                {t("auth:login.signupHint")}
              </Link>
            </div>
          )}
        </AuthCard>
      )}
    </AuthConfigGate>
  );
}

function SignInForm({
  lang,
  redirectTo,
  showForgotPassword,
  onNeeds2FA,
}: {
  lang: string;
  redirectTo: string;
  showForgotPassword: boolean;
  onNeeds2FA: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation(["auth"]);

  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      let result: Awaited<ReturnType<typeof authClient.signIn.email>>;
      try {
        result = await authClient.signIn.email({
          email: value.email,
          password: value.password,
        });
      } catch (err) {
        // The request itself failed (offline, server unreachable): say so,
        // and the same credentials can be sent again.
        console.error("[login.signIn]", err);
        toast.error(signInFailureMessage(err, t("auth:errors.invalidCredentials")));
        return;
      }
      if (result.error) {
        // `requireEmailVerification` rejects correct credentials on an
        // unverified account. Better-Auth distinguishes this itself, so say so
        // — the generic "email or password doesn't match" sends the user to
        // password reset for a problem a link in their inbox already solves.
        // This leaks nothing: the caller supplied the matching password.
        //
        // `emailVerification.sendOnSignIn` is on, so Better-Auth has already
        // mailed a fresh link by the time we get here — but the original may
        // have expired days ago, so the toast also offers the resend page
        // rather than leaving a dead end if that mail doesn't arrive.
        if (result.error.code === "EMAIL_NOT_VERIFIED") {
          toast.error(t("auth:verifyEmail.notVerified"), {
            action: {
              label: t("auth:verifyEmail.resend"),
              onClick: () =>
                navigate({
                  to: "/$lang/verify-email",
                  params: { lang },
                  // No `ok`: this is a self-navigation, not a verification hop,
                  // so the page must show its neutral resend state.
                  search: { error: undefined, ok: undefined },
                }),
            },
          });
          return;
        }
        // "Doesn't match" only for a true credential rejection; a rate limit,
        // a 5xx or a 401 FAILED_TO_CREATE_SESSION (the credentials were
        // right) gets the shared failure copy instead.
        toast.error(signInFailureMessage(result.error, t("auth:errors.invalidCredentials")));
        return;
      }
      if ((result.data as Record<string, unknown>)?.twoFactorRedirect) {
        onNeeds2FA();
        return;
      }
      toast.success(t("auth:signedInSuccess"));
      if (redirectTo === appHomeHref(lang)) {
        // The home is the public arena: its header reads the session-cookie
        // hint (lib/session-hint.ts), which may still hold this tab's
        // signed-out answer. It is signed in now.
        setSessionHint(queryClient, true);
        navigate({ to: APP_HOME, params: { lang } });
      } else {
        window.location.assign(redirectTo);
      }
    },
    validators: {
      // Validation messages come from the locale-aware Zod error map installed
      // in `@/i18n/zod`. Don't pass inline strings here — that would override
      // the global map and leak hardcoded English copy into es-MX UIs.
      onSubmit: z.object({
        email: z.email(),
        password: z.string().min(8),
      }),
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      className="space-y-4"
    >
      <form.Field name="email">
        {(field) => (
          <TextField
            field={field}
            label={t("auth:fields.email")}
            type="email"
            autoComplete="email"
          />
        )}
      </form.Field>

      {/* Phones: "Forgot password?" sits in the Password label's row, so
          turning email on does not push the sign-up link 44px further down,
          toward a first visit's cookie banner. Its 44px box fills the space from
          the email input's bottom edge to the password input's top edge (the
          6px `pt` makes that space 44px) and never overlaps either input; the
          label is aligned to the box's bottom. From `sm` up it keeps its own
          row under the field. DOM order is the same at every width: password,
          then the link, then submit. */}
      <div className={cn("relative space-y-4", showForgotPassword && "max-sm:pt-1.5")}>
        <form.Field name="password">
          {(field) => (
            <TextField
              field={field}
              label={t("auth:fields.password")}
              type="password"
              autoComplete="current-password"
            />
          )}
        </form.Field>

        {showForgotPassword && (
          <div className="text-right max-sm:absolute max-sm:-top-4 max-sm:right-0 max-sm:mt-0">
            <Link
              to="/$lang/forgot-password"
              params={{ lang }}
              search={{ redirectTo }}
              className={cn(
                buttonVariants({ variant: "link" }),
                "min-h-[44px] px-0 text-sm text-muted-foreground max-sm:h-11 max-sm:items-end max-sm:pb-[5px]",
              )}
            >
              {t("auth:login.forgotPassword")}
            </Link>
          </div>
        )}
      </div>

      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button
            type="submit"
            className="min-h-[44px] w-full"
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? t("auth:login.signingIn") : t("auth:login.signIn")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
