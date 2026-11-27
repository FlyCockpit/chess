import type { AppRouterClient } from "@cockpit-chess/api/routers/index";
import { useTranslation } from "react-i18next";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { orpc } from "@/utils/orpc";

export type RunnerRow = Awaited<
  ReturnType<AppRouterClient["cliAccess"]["runners"]["list"]>
>["items"][number];

export function RevokeRunnerDialog({
  runner,
  open,
  onOpenChange,
}: {
  runner: RunnerRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const revoke = useEntityMutation(
    orpc.cliAccess.runners.revoke.mutationOptions({
      onSuccess: () => onOpenChange(false),
    }),
    {
      invalidateKey: orpc.cliAccess.runners.key(),
      successMessage: t("settings:cli.runners.revokeDialog.success"),
    },
  );

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("settings:cli.runners.revokeDialog.title")}
      description={t("settings:cli.runners.revokeDialog.description")}
      confirmToken={runner?.displayName || runner?.credentialPrefix || ""}
      typePrompt={t("settings:cli.runners.revokeDialog.typeNameToConfirm")}
      copyAriaLabel={t("settings:cli.runners.revokeDialog.copyNameAriaLabel")}
      inputMode="text"
      confirmLabel={t("settings:cli.runners.revokeDialog.confirm")}
      pendingLabel={t("settings:cli.runners.revokeDialog.pending")}
      isPending={revoke.isPending}
      onConfirm={() => {
        if (runner) revoke.mutate({ id: runner.id });
      }}
    />
  );
}
