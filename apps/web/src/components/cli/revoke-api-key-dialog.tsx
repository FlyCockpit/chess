import type { AppRouterClient } from "@cockpit-chess/api/routers/index";
import { useTranslation } from "react-i18next";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { orpc } from "@/utils/orpc";

/** One row of `cliAccess.apiKeys.list`, exactly as the server projects it. */
export type ApiKeyRow = Awaited<
  ReturnType<AppRouterClient["cliAccess"]["apiKeys"]["list"]>
>[number];

/**
 * Delete → AlertDialog with type-to-confirm (packages/ui/src/components/dialog.tsx), via the
 * shared `ConfirmDeleteDialog`. Revoking is immediate and irreversible for
 * whatever CI job holds the key, so the name must be typed.
 */
export function RevokeApiKeyDialog({
  apiKey,
  open,
  onOpenChange,
}: {
  apiKey: ApiKeyRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);

  const revoke = useEntityMutation(
    orpc.cliAccess.apiKeys.revoke.mutationOptions({
      onSuccess: () => {
        onOpenChange(false);
      },
    }),
    {
      invalidateKey: orpc.cliAccess.apiKeys.key(),
      successMessage: t("settings:cli.apiKeys.revokeDialog.success"),
    },
  );

  return (
    <ConfirmDeleteDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("settings:cli.apiKeys.revokeDialog.title")}
      description={t("settings:cli.apiKeys.revokeDialog.description")}
      // Empty while no key is selected, which keeps the action disabled.
      confirmToken={apiKey?.name || apiKey?.start || ""}
      typePrompt={t("settings:cli.apiKeys.revokeDialog.typeNameToConfirm")}
      copyAriaLabel={t("settings:cli.apiKeys.revokeDialog.copyNameAriaLabel")}
      inputMode="text"
      confirmLabel={t("settings:cli.apiKeys.revokeDialog.confirm")}
      pendingLabel={t("settings:cli.apiKeys.revokeDialog.pending")}
      isPending={revoke.isPending}
      onConfirm={() => {
        if (!apiKey) return;
        revoke.mutate({ id: apiKey.id });
      }}
    />
  );
}
