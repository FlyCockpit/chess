import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ZodType } from "zod";

type FormValues = {
  reason: "privacy" | "harassment" | "illegal_content" | "spam" | "other";
  note: string;
};
const fixture = vi.hoisted(() => ({
  form: undefined as unknown,
  mutation: {
    isPending: false,
    isSuccess: false,
    isError: false,
    mutateAsync: vi.fn(async () => ({ accepted: true })),
    reset: vi.fn(),
  },
}));
vi.mock("@tanstack/react-form", async (original) => {
  const actual = await original<typeof import("@tanstack/react-form")>();
  return {
    ...actual,
    useForm: (options: Parameters<typeof actual.useForm>[0]) => {
      fixture.form = options;
      return actual.useForm(options);
    },
  };
});
vi.mock("@tanstack/react-query", () => ({ useMutation: () => fixture.mutation }));
vi.mock("@/utils/orpc", () => ({
  orpc: { chessModeration: { report: { mutationOptions: (value: unknown) => value } } },
}));
vi.mock("@cockpit-chess/ui/components/dialog", () => {
  const Part = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: Part,
    DialogTrigger: Part,
    DialogContent: Part,
    DialogDescription: Part,
    DialogFooter: Part,
    DialogHeader: Part,
    DialogTitle: Part,
    DialogClose: Part,
  };
});

import { ReplayReportDialog } from "./replay-report-dialog";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { chess: enChess, common: enCommon } },
    defaultNS: "chess",
    react: { useSuspense: false },
  });
});
beforeEach(() => {
  fixture.mutation.isSuccess = false;
  fixture.mutation.isError = false;
  fixture.mutation.isPending = false;
  fixture.mutation.mutateAsync.mockClear();
});
function render() {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ReplayReportDialog slug="public-replay" />
    </I18nextProvider>,
  );
}
function form() {
  return fixture.form as {
    validators: { onSubmit: ZodType<FormValues> };
    onSubmit: ({ value }: { value: FormValues }) => Promise<void>;
  };
}
it("lets an anonymous reader submit a bounded note with no identity or transcript", async () => {
  const html = render();
  expect(html).toContain(enChess.moderation.reportDescription);
  expect(html).toContain('maxLength="1000"');
  await form().onSubmit({ value: { reason: "privacy", note: "  A contact detail is visible.  " } });
  expect(fixture.mutation.mutateAsync).toHaveBeenCalledExactlyOnceWith({
    slug: "public-replay",
    reason: "privacy",
    note: "A contact detail is visible.",
  });
  expect(
    form().validators.onSubmit.safeParse({ reason: "privacy", note: "a".repeat(1001) }).success,
  ).toBe(false);
});
it("sends an empty optional note as absent and renders a receipt after acceptance", async () => {
  render();
  await form().onSubmit({ value: { reason: "other", note: " " } });
  expect(fixture.mutation.mutateAsync).toHaveBeenCalledExactlyOnceWith({
    slug: "public-replay",
    reason: "other",
    note: undefined,
  });
  fixture.mutation.isSuccess = true;
  const html = render();
  expect(html).toContain(enChess.moderation.received);
  expect(html).not.toContain("<textarea");
});
it("shows an actionable inline failure without losing the form", () => {
  fixture.mutation.isError = true;
  const html = render();
  expect(html).toContain(enChess.moderation.reportFailed);
  expect(html).toContain("<textarea");
});
