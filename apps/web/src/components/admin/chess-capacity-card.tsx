import type { AppRouterClient } from "@cockpit-chess/api/routers/index";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cockpit-chess/ui/components/card";
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useTranslation } from "react-i18next";

import { QueryBoundary } from "@/components/query-boundary";
import { orpc } from "@/utils/orpc";

export type ChessCapacity = Awaited<ReturnType<AppRouterClient["chess"]["capacity"]>>;
/** How often the open overview asks again: the counts move as matches start and end. */
const CAPACITY_POLL_MS = 5000;

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

/** The capacity numbers and the bounded running/queued list, from `chess.capacity`. */
export function ChessCapacityView({ capacity }: { capacity: ChessCapacity }) {
  const { t, i18n } = useTranslation(["admin"]);
  const number = (value: number) => value.toLocaleString(i18n.language);
  const engine = capacity.engine;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label={t("admin:capacity.running")}
          value={t("admin:capacity.runningValue", {
            count: number(capacity.running),
            limit: number(capacity.concurrencyLimit),
          })}
        />
        <Stat
          label={t("admin:capacity.queued")}
          value={t("admin:capacity.queuedValue", {
            count: number(capacity.queued),
            limit: number(capacity.queueCap),
          })}
        />
        <Stat
          label={t("admin:capacity.engine")}
          value={
            engine
              ? t("admin:capacity.engineValue", {
                  busy: number(engine.busy),
                  total: number(engine.total),
                })
              : "—"
          }
          note={
            engine
              ? [
                  t("admin:capacity.engineWaiting", { count: engine.waiting }),
                  t("admin:capacity.workers", { count: engine.workers }),
                ].join(" · ")
              : undefined
          }
        />
      </div>
      {!engine && (
        <p role="status" className="text-sm text-destructive">
          {t("admin:capacity.noWorker")}
        </p>
      )}
      <div>
        <h3 className="mb-2 text-sm font-medium">{t("admin:capacity.listTitle")}</h3>
        {capacity.matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin:capacity.empty")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {capacity.matches.map((match) => (
              <li key={match.slug} className="min-w-0 px-3 py-2">
                <p className="truncate text-sm font-medium">{match.title}</p>
                <p className="text-xs text-muted-foreground">
                  {[
                    match.ownerName,
                    t(`admin:capacity.status.${match.status === "running" ? "running" : "queued"}`),
                    new Date(match.createdAt).toLocaleString(i18n.language, {
                      dateStyle: "short",
                      timeStyle: "short",
                    }),
                  ].join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Admin overview: how many hosted matches run and wait, and the engine pool's load. */
export function ChessCapacityCard() {
  const { t } = useTranslation(["admin"]);
  const query = useQuery({
    ...orpc.chess.capacity.queryOptions(),
    refetchInterval: CAPACITY_POLL_MS,
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity aria-hidden="true" className="size-4" />
          {t("admin:capacity.title")}
        </CardTitle>
        <CardDescription>{t("admin:capacity.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryBoundary
          query={query}
          errorMessage={t("admin:capacity.loadFailed")}
          skeleton={
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[0, 1, 2].map((key) => (
                  <Skeleton key={key} className="h-20" />
                ))}
              </div>
              <Skeleton className="h-24" />
            </div>
          }
        >
          {(capacity) => <ChessCapacityView capacity={capacity} />}
        </QueryBoundary>
      </CardContent>
    </Card>
  );
}
