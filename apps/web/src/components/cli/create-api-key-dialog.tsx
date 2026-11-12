import { Button } from "@cockpit-chess/ui/components/button";
import { CopyField } from "@cockpit-chess/ui/components/copy-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@cockpit-chess/ui/components/dialog";
import { Label } from "@cockpit-chess/ui/components/label";
import { toast } from "@cockpit-chess/ui/components/sileo";
import { TextField } from "@cockpit-chess/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { z } from "zod";

import { SegmentedControl } from "@/components/segmented-control";
import { useEntityMutation } from "@/hooks/use-entity-mutation";
import { orpc } from "@/utils/orpc";

/** Mirrors `API_KEY_EXPIRY_DAYS` in packages/api/src/routers/cli-access.ts. */
const EXPIRY_OPTIONS = ["30", "90", "365"] as const;
type ExpiryOption = (typeof EXPIRY_OPTIONS)[number];

const DAYS: Record<ExpiryOption, 30 | 90 | 365> = { "30": 30, "90": 90, "365": 365 };

/** Mirrors the `cliAccess.apiKeys.create` input. The server validates again. */
const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(64),
});

/**
 * Create → Dialog (packages/ui/src/components/dialog.tsx). On success the dialog swaps the form
 * for the plaintext key, which the server returns exactly once; closing the
 * dialog drops it from memory for good.
 */
export function CreateApiKeyDialog() {
  const { t } = useTranslation(["settings", "common"]);
  const [open, setOpen] = useState(false);
  const [expiry, setExpiry] = useState<ExpiryOption>("90");
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const create = useEntityMutation(
    orpc.cliAccess.apiKeys.create.mutationOptions({
      onSuccess: (created) => {
        setCreatedKey(created.key);
      },
    }),
    // Only the key list: invalidating all of `cliAccess` would also refetch
    // the install command and mint a fresh token for no reason.
    { invalidateKey: orpc.cliAccess.apiKeys.key() },
  );

  const form = useForm({
    defaultValues: { name: "" },
    validators: { onChange: createApiKeySchema },
    onSubmit: ({ value }) => {
      create.mutate({ name: value.name.trim(), expiresInDays: DAYS[expiry] });
    },
  });

  const handleOpenChange = (next: boolean) => {
    // Don't let a click-away discard a submission already in flight.
    if (create.isPending) return;
    setOpen(next);
    if (!next) {
      setCreatedKey(null);
      setExpiry("90");
      form.reset();
      create.reset();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button className="min-h-[44px]">
            <Plus aria-hidden className="size-4" />
            {t("settings:cli.apiKeys.new")}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        {createdKey ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("settings:cli.apiKeys.create.createdTitle")}</DialogTitle>
              <DialogDescription>
                {t("settings:cli.apiKeys.create.createdWarning")}
              </DialogDescription>
            </DialogHeader>
            <div className="min-w-0 space-y-3">
              <CopyField
                value={createdKey}
                copyLabel={t("settings:cli.apiKeys.create.copyAriaLabel")}
                onCopied={() => toast.success(t("settings:cli.apiKeys.create.copied"))}
              />
              <p className="text-sm text-muted-foreground">
                <Trans
                  i18nKey="cli.apiKeys.create.usage"
                  ns="settings"
                  t={t}
                  components={[<code key="0" />, <code key="1" />]}
                />
              </p>
            </div>
            <DialogFooter>
              <Button
                className="min-h-[44px] w-full sm:w-auto"
                onClick={() => handleOpenChange(false)}
              >
                {t("settings:cli.apiKeys.create.done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("settings:cli.apiKeys.create.title")}</DialogTitle>
              <DialogDescription>{t("settings:cli.apiKeys.create.description")}</DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                e.stopPropagation();
                form.handleSubmit();
              }}
              className="space-y-4"
            >
              <form.Field name="name">
                {(field) => (
                  <TextField
                    field={field}
                    label={t("settings:cli.apiKeys.create.nameLabel")}
                    placeholder={t("settings:cli.apiKeys.create.namePlaceholder")}
                    // A key label has no autofill token and implies no keyboard.
                    inputMode="text"
                    autoComplete="off"
                    maxLength={64}
                    className="space-y-1.5"
                  />
                )}
              </form.Field>

              <div className="space-y-1.5">
                <Label>{t("settings:cli.apiKeys.create.expiryLabel")}</Label>
                <SegmentedControl
                  value={expiry}
                  onChange={setExpiry}
                  ariaLabel={t("settings:cli.apiKeys.create.expiryLabel")}
                  items={EXPIRY_OPTIONS.map((value) => ({
                    value,
                    label: t("settings:cli.apiKeys.create.days", { count: DAYS[value] }),
                  }))}
                />
              </div>

              <form.Subscribe selector={(state) => state.canSubmit}>
                {(canSubmit) => (
                  <Button
                    type="submit"
                    className="min-h-[44px] w-full"
                    disabled={!canSubmit || create.isPending}
                  >
                    <KeyRound aria-hidden className="size-4" />
                    {create.isPending
                      ? t("settings:cli.apiKeys.create.submitting")
                      : t("settings:cli.apiKeys.create.submit")}
                  </Button>
                )}
              </form.Subscribe>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
