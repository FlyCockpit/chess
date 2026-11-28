import { Button } from "@cockpit-chess/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@cockpit-chess/ui/components/dialog";
import { SelectField, TextareaField } from "@cockpit-chess/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { Flag } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { orpc } from "@/utils/orpc";

const reasons = ["privacy", "harassment", "illegal_content", "spam", "other"] as const;

/** Reporting is available to every reader; no account or contact details are required. */
export function ReplayReportDialog({ slug }: { slug: string }) {
  const { t } = useTranslation(["chess", "common"]);
  const [open, setOpen] = useState(false);
  const report = useMutation(
    orpc.chessModeration.report.mutationOptions({
      meta: { skipGlobalErrorToast: true },
    }),
  );
  const form = useForm({
    defaultValues: { reason: "other" as (typeof reasons)[number], note: "" },
    validators: {
      onSubmit: z.object({
        reason: z.enum(reasons),
        note: z.string().trim().max(1000, t("chess:moderation.noteLimit")),
      }),
    },
    onSubmit: async ({ value }) => {
      try {
        await report.mutateAsync({
          slug,
          reason: value.reason,
          note: value.note.trim() || undefined,
        });
      } catch {
        // The same form remains available for an explicit retry; no report text is logged.
      }
    },
  });
  const changeOpen = (value: boolean) => {
    setOpen(value);
    if (!value) {
      form.reset();
      report.reset();
    }
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" className="min-h-11" />}>
        <Flag size={16} aria-hidden="true" />
        {t("chess:moderation.report")}
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("chess:moderation.reportTitle")}</DialogTitle>
          <DialogDescription>{t("chess:moderation.reportDescription")}</DialogDescription>
          <p className="text-sm text-muted-foreground">
            {t("common:legal.reportContact")}{" "}
            <a
              href="mailto:contact@flycockpit.app"
              className="inline-flex min-h-11 items-center break-all underline underline-offset-4"
            >
              {t("common:legal.contactAddress")}
            </a>
          </p>
        </DialogHeader>
        {report.isSuccess ? (
          <>
            <p role="status">{t("chess:moderation.received")}</p>
            <DialogFooter>
              <DialogClose render={<Button className="min-h-11" />}>
                {t("common:actions.close")}
              </DialogClose>
            </DialogFooter>
          </>
        ) : (
          <form
            noValidate
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <form.Field name="reason">
              {(field) => (
                <SelectField
                  field={field}
                  label={t("chess:moderation.reason")}
                  disabled={report.isPending}
                  options={reasons.map((value) => ({
                    value,
                    label: t(`chess:moderation.reasons.${value}`),
                  }))}
                />
              )}
            </form.Field>
            <form.Field name="note">
              {(field) => (
                <TextareaField
                  field={field}
                  label={t("chess:moderation.note")}
                  description={t("chess:moderation.noteHelp")}
                  autoComplete="off"
                  inputMode="text"
                  maxLength={1000}
                  rows={4}
                  disabled={report.isPending}
                />
              )}
            </form.Field>
            {report.isError && (
              <p role="alert" className="text-sm text-destructive">
                {t("chess:moderation.reportFailed")}
              </p>
            )}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" className="min-h-11" />}>
                {t("common:actions.cancel")}
              </DialogClose>
              <Button type="submit" className="min-h-11" disabled={report.isPending}>
                {t(report.isPending ? "chess:moderation.sending" : "chess:moderation.send")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
