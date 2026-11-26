import { cn } from "@cockpit-chess/ui/lib/utils";
import type { ReactNode } from "react";

const WIDTH_CLASS = {
  narrow: "max-w-4xl",
  default: "max-w-5xl",
  wide: "max-w-7xl",
} as const;

const PAGE_FRAME = "container mx-auto px-4";

/** The widest page column, for content inside a full-bleed band (a banner):
 * the band's background spans the window, its content lines up with the
 * widest page below it. docs/design-system.md § Viewport scale */
export const PAGE_COLUMN_CLASS = `${PAGE_FRAME} ${WIDTH_CLASS.wide}`;

type PageShellProps = {
  width?: keyof typeof WIDTH_CLASS;
  className?: string;
  children: ReactNode;
};

export function PageShell({ width = "default", className, children }: PageShellProps) {
  return (
    <div className={cn(PAGE_FRAME, "space-y-6 py-8", WIDTH_CLASS[width], className)}>
      {children}
    </div>
  );
}

type PageHeaderProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <header className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        {description ? (
          <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
        ) : null}
      </header>
      {actions}
    </div>
  );
}
