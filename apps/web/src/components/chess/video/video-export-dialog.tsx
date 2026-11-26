import type { MatchArchive } from "@cockpit-chess/chess";
import { Button } from "@cockpit-chess/ui/components/button";
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
import { Skeleton } from "@cockpit-chess/ui/components/skeleton";
import { Switch } from "@cockpit-chess/ui/components/switch";
import { Film } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/segmented-control";
import { useMountEffect } from "@/hooks/use-mount-effect";
import { createGeneration, encodeVideo, probeVideoSupport } from "./video-export";
import {
  buildVideoPlan,
  defaultVideoOptions,
  formatClock,
  VIDEO_ASPECTS,
  VIDEO_PACES,
  type VideoAspect,
  type VideoOptions,
  videoFeatures,
  videoFileName,
  X_MAX_SECONDS,
} from "./video-plan";

type Phase =
  | { name: "probing" }
  | { name: "unsupported" }
  | { name: "ready" }
  | { name: "encoding"; done: number; total: number }
  | { name: "done"; url: string; fileName: string; bytes: number }
  | { name: "error" };

const TOGGLES = ["evalBar", "remarks", "clocks"] as const;

function save(url: string, fileName: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
}

/** Export → Dialog: options, then an in-browser MP4 encode with progress and cancel. */
export function VideoExportDialog({ match }: { match: MatchArchive }) {
  const { t } = useTranslation("chess");
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ name: "probing" });
  const [options, setOptions] = useState<VideoOptions>(() => defaultVideoOptions(match));
  // One support check per aspect while the dialog is open (each is a short-lived worker).
  const codecs = useRef<Partial<Record<VideoAspect, Promise<string | null>>>>({});
  const probes = useRef<AbortController | null>(null);
  const abort = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const features = useMemo(() => videoFeatures(match), [match]);
  const translate = t as unknown as (
    key: string,
    params?: Record<string, string | number>,
  ) => string;
  const plan = useMemo(
    () => (open ? buildVideoPlan(match, options, translate) : null),
    [open, match, options, translate],
  );
  const seconds = plan ? plan.totalFrames / plan.fps : 0;

  const release = () => {
    abort.current?.abort();
    abort.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  };
  // Each check gets a generation; closing the dialog or a newer check makes
  // an older answer stale, so it can never overwrite a later phase.
  const [probeRun] = useState(createGeneration);
  const stopProbes = () => {
    probeRun.invalidate();
    probes.current?.abort();
    probes.current = null;
    codecs.current = {};
  };
  // Leaving the page mid-export stops every worker and frees the file.
  useMountEffect(() => () => {
    release();
    stopProbes();
  });

  const checkSupport = (aspect: VideoAspect) => {
    const isCurrent = probeRun.start();
    setPhase({ name: "probing" });
    probes.current ??= new AbortController();
    codecs.current[aspect] ??= probeVideoSupport(aspect, probes.current.signal);
    void codecs.current[aspect].then((codec) => {
      if (isCurrent()) setPhase(codec ? { name: "ready" } : { name: "unsupported" });
    });
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      release();
      stopProbes();
      setPhase({ name: "probing" });
      return;
    }
    const defaults = defaultVideoOptions(match);
    setOptions(defaults);
    checkSupport(defaults.aspect);
  };

  const setAspect = (aspect: VideoAspect) => {
    setOptions((current) => ({ ...current, aspect }));
    checkSupport(aspect);
  };

  const start = async () => {
    const codec = await codecs.current[options.aspect];
    if (!plan || !codec) return;
    release();
    probeRun.invalidate();
    const controller = new AbortController();
    abort.current = controller;
    setPhase({ name: "encoding", done: 0, total: plan.totalFrames });
    try {
      const blob = await encodeVideo(
        plan,
        options.aspect,
        codec,
        (done, total) => {
          if (!controller.signal.aborted) setPhase({ name: "encoding", done, total });
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      objectUrl.current = url;
      const fileName = videoFileName(match);
      setPhase({ name: "done", url, fileName, bytes: blob.size });
      save(url, fileName);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("video export failed", error);
      setPhase({ name: "error" });
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  };

  const cancel = () => {
    release();
    setPhase({ name: "ready" });
  };

  const busy = phase.name === "encoding";
  const percent =
    phase.name === "encoding" && phase.total > 0 ? Math.floor((phase.done / phase.total) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <button type="button">
            <Film size={15} aria-hidden />
            {t("video.open")}
          </button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("video.title")}</DialogTitle>
          <DialogDescription>{t("video.description")}</DialogDescription>
        </DialogHeader>
        {phase.name === "probing" && (
          <div className="min-w-0 space-y-3" aria-busy="true">
            <p className="text-sm text-muted-foreground">{t("video.probing")}</p>
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        )}
        {(phase.name === "ready" || phase.name === "error" || phase.name === "unsupported") && (
          <div className="min-w-0 space-y-4">
            {phase.name === "unsupported" && (
              <p role="alert" className="text-sm">
                {t("video.unsupported", { size: t(`video.aspects.${options.aspect}`) })}
              </p>
            )}
            <div className="space-y-2">
              <Label>{t("video.aspect")}</Label>
              <SegmentedControl
                ariaLabel={t("video.aspect")}
                value={options.aspect}
                onChange={setAspect}
                items={VIDEO_ASPECTS.map((value) => ({
                  value,
                  label: t(`video.aspects.${value}`),
                }))}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("video.pace")}</Label>
              <SegmentedControl
                ariaLabel={t("video.pace")}
                value={options.pace}
                onChange={(pace) => setOptions((current) => ({ ...current, pace }))}
                items={VIDEO_PACES.map((value) => ({
                  value,
                  label:
                    value === "auto"
                      ? t("video.paceAuto")
                      : t("video.paceSeconds", { seconds: value }),
                }))}
              />
            </div>
            {TOGGLES.some((key) => features[key]) && (
              <div className="space-y-1">
                {TOGGLES.filter((key) => features[key]).map((key) => (
                  <div key={key} className="flex items-center justify-between gap-4">
                    {/* The label fills the row, so the whole 44 px row toggles the switch. */}
                    <Label
                      htmlFor={`video-${key}`}
                      className="flex min-h-11 flex-1 cursor-pointer items-center"
                    >
                      {t(`video.toggles.${key}`)}
                    </Label>
                    <Switch
                      id={`video-${key}`}
                      checked={options[key]}
                      onCheckedChange={(checked) =>
                        setOptions((current) => ({ ...current, [key]: checked }))
                      }
                    />
                  </div>
                ))}
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              {t("video.summary", {
                duration: formatClock(seconds * 1000),
                size: plan ? `${plan.width}×${plan.height}` : "",
              })}
            </p>
            {seconds > X_MAX_SECONDS && (
              <p role="status" className="text-sm text-destructive">
                {t("video.tooLong")}
              </p>
            )}
            {phase.name === "error" && (
              <p role="alert" className="text-sm text-destructive">
                {t("video.failed")}
              </p>
            )}
          </div>
        )}
        {phase.name === "encoding" && (
          <div className="min-w-0 space-y-2">
            <div
              role="progressbar"
              aria-label={t("video.progress")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-3 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t("video.encoding", { percent })}
            </p>
          </div>
        )}
        {phase.name === "done" && (
          <p className="text-sm" aria-live="polite">
            {t("video.done", {
              file: phase.fileName,
              size: (phase.bytes / 1_000_000).toFixed(1),
            })}
          </p>
        )}
        <DialogFooter>
          {busy ? (
            <Button variant="outline" className="min-h-[44px] w-full sm:w-auto" onClick={cancel}>
              {t("video.cancel")}
            </Button>
          ) : phase.name === "done" ? (
            <Button
              className="min-h-[44px] w-full sm:w-auto"
              onClick={() => save(phase.url, phase.fileName)}
            >
              {t("video.downloadAgain")}
            </Button>
          ) : (
            <Button
              className="min-h-[44px] w-full sm:w-auto"
              disabled={phase.name !== "ready" && phase.name !== "error"}
              onClick={() => void start()}
            >
              {t(phase.name === "error" ? "video.retry" : "video.start")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
