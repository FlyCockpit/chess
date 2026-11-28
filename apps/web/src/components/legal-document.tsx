import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** Legal pages share the public shell's main scroller and footer. */
export function LegalDocument({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation("common");
  return (
    <article className="mx-auto w-full min-w-0 max-w-3xl space-y-8 px-4 py-10 sm:px-6">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{t("legal.updated")}</p>
        <p className="rounded-md border p-4 text-sm">{t("legal.reviewNotice")}</p>
      </header>
      <div className="space-y-8 text-base leading-relaxed [&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center [&_a]:break-all [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_p]:mb-3">
        {children}
      </div>
    </article>
  );
}

export function LegalSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-xl font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}
