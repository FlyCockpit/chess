import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import { createInstance } from "i18next";
import type { ComponentProps, EffectCallback, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  states: 0,
  refs: 0,
  phase: { name: "ready" } as
    | { name: "ready" }
    | { name: "done"; url: string; fileName: string; bytes: number },
  buttons: new Map<string, () => void>(),
  close: undefined as ((open: boolean) => void) | undefined,
  cleanup: undefined as (() => void) | undefined,
  encode: vi.fn<() => Promise<Blob>>(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = fixture.states++;
      return actual.useState(index === 0 ? true : index === 1 ? fixture.phase : initial);
    },
    useRef: (initial: unknown) => {
      const index = fixture.refs++;
      return actual.useRef(
        index === 3 && fixture.phase.name === "done" ? fixture.phase.url : initial,
      );
    },
  };
});
vi.mock("@/hooks/use-mount-effect", () => ({
  useMountEffect: (effect: EffectCallback) => {
    const cleanup = effect();
    fixture.cleanup = typeof cleanup === "function" ? () => cleanup() : undefined;
  },
}));
vi.mock("@cockpit-chess/ui/components/button", () => ({
  Button: (props: ComponentProps<"button">) => {
    const click = props.onClick;
    if (typeof props.children === "string" && click)
      fixture.buttons.set(props.children, () =>
        click({} as import("react").MouseEvent<HTMLButtonElement>),
      );
    return <button {...props} />;
  },
}));
vi.mock("@cockpit-chess/ui/components/dialog", () => {
  const Part = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({
      children,
      onOpenChange,
    }: {
      children?: ReactNode;
      onOpenChange: (open: boolean) => void;
    }) => {
      fixture.close = onOpenChange;
      return <div>{children}</div>;
    },
    DialogTrigger: Part,
    DialogContent: Part,
    DialogDescription: Part,
    DialogFooter: Part,
    DialogHeader: Part,
    DialogTitle: Part,
  };
});
vi.mock("@/components/segmented-control", () => ({ SegmentedControl: () => null }));
vi.mock("@cockpit-chess/ui/components/switch", () => ({ Switch: () => null }));
vi.mock("@cockpit-chess/ui/components/label", () => ({
  Label: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./video-export", async (original) => ({
  ...(await original<typeof import("./video-export")>()),
  probeVideoSupport: async () => "avc1.test",
  encodeVideo: () => fixture.encode(),
}));

import { VideoExportDialog } from "./video-export-dialog";
import { videoFixtureGame } from "./video-fixture";

const i18n = createInstance();
const anchor = { click: vi.fn(), href: "", download: "" };
const flush = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess } },
    defaultNS: "chess",
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  fixture.states = 0;
  fixture.refs = 0;
  fixture.phase = { name: "ready" };
  fixture.buttons.clear();
  fixture.cleanup = undefined;
  fixture.close = undefined;
  fixture.encode.mockReset().mockResolvedValue(new Blob(["video"]));
  anchor.click.mockClear();
  vi.stubGlobal("document", { createElement: () => anchor });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:encoded");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  fixture.cleanup?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(check: () => Promise<boolean>) {
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <VideoExportDialog match={videoFixtureGame()} beforeExport={check} />
    </I18nextProvider>,
  );
  if (fixture.phase.name === "ready") fixture.close?.(true);
  await flush();
}
async function click(label: string) {
  expect(fixture.buttons.has(label)).toBe(true);
  fixture.buttons.get(label)?.();
  await flush();
}

it("refuses encoding when the fresh visibility check fails", async () => {
  await render(async () => false);
  await click(enChess.video.start);
  expect(fixture.encode).not.toHaveBeenCalled();
  expect(anchor.click).not.toHaveBeenCalled();
});
it("rechecks visibility after encoding and refuses the automatic download", async () => {
  const encoding = deferred<Blob>();
  fixture.encode.mockReturnValueOnce(encoding.promise);
  const check = vi
    .fn(async () => true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  await render(check);
  await click(enChess.video.start);
  expect(fixture.encode).toHaveBeenCalledOnce();
  encoding.resolve(new Blob(["completed"]));
  await flush();
  expect(check).toHaveBeenCalledTimes(2);
  expect(anchor.click).not.toHaveBeenCalled();
});
it("rechecks a completed file before Download again", async () => {
  fixture.phase = { name: "done", url: "blob:earlier", fileName: "game.mp4", bytes: 100 };
  const check = vi.fn(async () => false);
  await render(check);
  await click(enChess.video.downloadAgain);
  expect(check).toHaveBeenCalledOnce();
  expect(anchor.click).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:earlier");
});
it.each(["close", "unmount"] as const)(
  "does not start encoding after %s while the visibility check is pending",
  async (action) => {
    const validation = deferred<boolean>();
    await render(() => validation.promise);
    await click(enChess.video.start);
    if (action === "close") fixture.close?.(false);
    else fixture.cleanup?.();
    validation.resolve(true);
    await flush();
    expect(fixture.encode).not.toHaveBeenCalled();
    expect(anchor.click).not.toHaveBeenCalled();
  },
);
it.each(["close", "unmount"] as const)(
  "does not download a late completed encode after %s",
  async (action) => {
    const encoding = deferred<Blob>();
    fixture.encode.mockReturnValueOnce(encoding.promise);
    await render(async () => true);
    await click(enChess.video.start);
    if (action === "close") fixture.close?.(false);
    else fixture.cleanup?.();
    encoding.resolve(new Blob(["late"]));
    await flush();
    expect(anchor.click).not.toHaveBeenCalled();
  },
);
