import { Button } from "@cockpit-chess/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-chess/ui/components/card";
import { TextField } from "@cockpit-chess/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { z } from "zod";

import { PageShell } from "@/components/page-shell";
import { authClient } from "@/lib/auth-client";

/**
 * /$lang/device — approve a `cockpit-chess login` request (RFC 8628 device flow).
 * See packages/api/src/routers/cli.ts
 * Better-Auth's `verificationUri` points at
 * `/device?user_code=…`, which the `$lang` layout redirects here.
 *
 * Authenticated (under `_auth`), so the approving session has already passed
 * sign-in and the forced-2FA guard. Approval hands a terminal a full session,
 * which makes this page a phishing target: the code is never auto-approved,
 * even when it arrives prefilled in the URL — the user confirms it and reads
 * the warning first.
 */
export const Route = createFileRoute("/$lang/_app/_auth/device")({
  validateSearch: (search: Record<string, unknown>) => ({
    user_code: typeof search.user_code === "string" ? search.user_code : undefined,
  }),
  component: DevicePage,
});

type Phase =
  | { kind: "enter"; error?: DeviceErrorKind }
  | { kind: "review"; userCode: string }
  | { kind: "approved" }
  | { kind: "denied" };

type DeviceErrorKind = "invalid" | "expired" | "alreadyProcessed" | "failed";

const codeSchema = z.object({ userCode: z.string().trim().min(1).max(64) });

/** Map Better-Auth's RFC 8628 error body (`{ error: "expired_token" }`) to page copy. */
function deviceErrorKind(error: unknown): DeviceErrorKind {
  const code =
    error && typeof error === "object" && "error" in error
      ? (error as { error?: unknown }).error
      : undefined;
  if (code === "expired_token") return "expired";
  if (code === "invalid_request") return "invalid";
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  return status === 400 ? "invalid" : "failed";
}

function DevicePage() {
  const { t } = useTranslation(["auth", "common"]);
  const { user_code } = Route.useSearch();
  const [phase, setPhase] = useState<Phase>({ kind: "enter" });

  return (
    <PageShell width="narrow" className="max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>{t("auth:device.title")}</CardTitle>
          <CardDescription>{t("auth:device.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {phase.kind === "enter" ? (
            <EnterCode
              initialCode={user_code ?? ""}
              error={phase.error}
              onVerified={(userCode) => setPhase({ kind: "review", userCode })}
              onError={(error) => setPhase({ kind: "enter", error })}
            />
          ) : phase.kind === "review" ? (
            <ReviewRequest
              userCode={phase.userCode}
              onDone={(outcome) =>
                setPhase(
                  outcome === "approved" || outcome === "denied"
                    ? { kind: outcome }
                    : { kind: "enter", error: outcome },
                )
              }
              onStartOver={() => setPhase({ kind: "enter" })}
            />
          ) : (
            <Outcome approved={phase.kind === "approved"} />
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}

function EnterCode({
  initialCode,
  error,
  onVerified,
  onError,
}: {
  initialCode: string;
  error: DeviceErrorKind | undefined;
  onVerified: (userCode: string) => void;
  onError: (error: DeviceErrorKind) => void;
}) {
  const { t } = useTranslation(["auth", "common"]);

  const form = useForm({
    defaultValues: { userCode: initialCode },
    validators: { onChange: codeSchema },
    onSubmit: async ({ value }) => {
      const userCode = value.userCode.trim();
      try {
        const result = await authClient.device({ query: { user_code: userCode } });
        if (result.error) {
          onError(deviceErrorKind(result.error));
          return;
        }
        if (result.data?.status !== "pending") {
          onError("alreadyProcessed");
          return;
        }
        onVerified(userCode);
      } catch (err) {
        console.error("[device.verify]", err);
        onError("failed");
      }
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
      {error ? <DeviceError kind={error} /> : null}
      <form.Field name="userCode">
        {(field) => (
          <TextField
            field={field}
            label={t("auth:device.codeLabel")}
            placeholder={t("auth:device.codePlaceholder")}
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={64}
            className="space-y-1.5"
          />
        )}
      </form.Field>
      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button
            type="submit"
            className="min-h-[44px] w-full"
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? t("auth:device.checking") : t("auth:device.continue")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}

function ReviewRequest({
  userCode,
  onDone,
  onStartOver,
}: {
  userCode: string;
  onDone: (outcome: "approved" | "denied" | DeviceErrorKind) => void;
  onStartOver: () => void;
}) {
  const { t } = useTranslation(["auth", "common"]);
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  const decide = async (action: "approve" | "deny") => {
    setPending(action);
    try {
      const result =
        action === "approve"
          ? await authClient.device.approve({ userCode })
          : await authClient.device.deny({ userCode });
      if (result.error) {
        onDone(deviceErrorKind(result.error));
        return;
      }
      onDone(action === "approve" ? "approved" : "denied");
    } catch (err) {
      console.error(`[device.${action}]`, err);
      onDone("failed");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">{t("auth:device.reviewTitle")}</p>
      <code className="block rounded-md border bg-muted px-3 py-2 text-center font-mono text-lg tracking-widest">
        {userCode}
      </code>
      <div className="flex gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <p>
          <Trans i18nKey="device.warning" ns="auth" t={t} components={[<code key="0" />]} />
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          className="min-h-[44px] flex-1"
          disabled={pending !== null}
          onClick={() => void decide("approve")}
        >
          {pending === "approve" ? t("auth:device.approving") : t("auth:device.approve")}
        </Button>
        <Button
          variant="outline"
          className="min-h-[44px] flex-1"
          disabled={pending !== null}
          onClick={() => void decide("deny")}
        >
          {pending === "deny" ? t("auth:device.denying") : t("auth:device.deny")}
        </Button>
      </div>
      <Button
        variant="ghost"
        className="min-h-[44px] w-full"
        disabled={pending !== null}
        onClick={onStartOver}
      >
        {t("auth:device.startOver")}
      </Button>
    </div>
  );
}

function DeviceError({ kind }: { kind: DeviceErrorKind }) {
  const { t } = useTranslation(["auth"]);
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {kind === "invalid" || kind === "failed" ? (
        t(`auth:device.${kind}`)
      ) : (
        <Trans i18nKey={`device.${kind}`} ns="auth" t={t} components={[<code key="0" />]} />
      )}
    </div>
  );
}

function Outcome({ approved }: { approved: boolean }) {
  const { t } = useTranslation(["auth"]);
  const Icon = approved ? CircleCheck : CircleX;
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <Icon
        aria-hidden
        className={approved ? "size-10 text-green-600" : "size-10 text-muted-foreground"}
      />
      <p className="font-medium">
        {approved ? t("auth:device.approvedTitle") : t("auth:device.deniedTitle")}
      </p>
      <p className="text-sm text-muted-foreground">
        {approved ? t("auth:device.approvedDescription") : t("auth:device.deniedDescription")}
      </p>
    </div>
  );
}
