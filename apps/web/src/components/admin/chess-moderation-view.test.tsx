import enChess from "@cockpit-chess/locales/src/en-US/chess.json";
import enCommon from "@cockpit-chess/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ZodType } from "zod";

const fixture = vi.hoisted(() => ({
  forms: [] as unknown[],
  options: undefined as unknown,
  query: {
    data: undefined as unknown,
    error: undefined as unknown,
    isPending: false,
    isError: false,
    fetchStatus: "idle",
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    hasNextPage: true,
    isFetchingNextPage: false,
  },
  mutateAsync: vi.fn(async () => ({})),
}));
vi.mock("@tanstack/react-form", async (original) => {
  const actual = await original<typeof import("@tanstack/react-form")>();
  return {
    ...actual,
    useForm: (options: Parameters<typeof actual.useForm>[0]) => {
      fixture.forms.push(options);
      return actual.useForm(options);
    },
  };
});
vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: (options: unknown) => {
    fixture.options = options;
    return fixture.query;
  },
  useMutation: () => ({
    isPending: false,
    isError: false,
    mutateAsync: fixture.mutateAsync,
    reset: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    chess: { key: () => ["chess"] },
    chessModeration: {
      key: () => ["moderation"],
      list: { infiniteOptions: (value: unknown) => value },
      setHidden: { mutationOptions: (value: unknown) => value },
    },
  },
}));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => true }));
vi.mock("@/components/segmented-control", () => ({ SegmentedControl: () => null }));
vi.mock("@/components/page-shell", () => ({
  PageShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHeader: ({ title, description }: { title: string; description: string }) => (
    <header>
      {title}
      {description}
    </header>
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
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

import { ChessModerationView } from "./chess-moderation-view";

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
  fixture.forms = [];
  fixture.mutateAsync.mockClear();
  fixture.query = {
    ...fixture.query,
    error: undefined,
    isPending: false,
    isError: false,
    data: {
      pages: [
        {
          items: [
            {
              id: "match",
              slug: "published",
              title: "Published replay",
              hiddenAt: null,
              published: true,
              moderationReason: null,
              moderationVersion: 0,
              _count: { Reports: 1 },
              Reports: [
                {
                  id: "report",
                  reason: "privacy",
                  note: "<script>untrusted</script>",
                  createdAt: new Date(0),
                  reviewedAt: null,
                },
              ],
              ModerationActions: [],
            },
          ],
        },
      ],
    },
  };
});
function render() {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ChessModerationView />
    </I18nextProvider>,
  );
}
type Form = {
  validators: { onSubmit: ZodType };
  onSubmit: ({
    value,
  }: {
    value: { reason: "privacy" | "no_violation"; note: string };
  }) => Promise<void>;
};
it("uses bounded cursor pages, escapes report text, and offers both hiding and keeping visible", () => {
  const html = render();
  expect(html).toContain("&lt;script&gt;untrusted&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain(enChess.moderation.hide);
  expect(html).toContain(enChess.moderation.keepVisible);
  expect(html).toContain(enCommon.actions.loadMore);
  const options = fixture.options as {
    input: (cursor?: string) => unknown;
    getNextPageParam: (page: { nextCursor: string }) => string;
  };
  expect(options.input("next")).toEqual({ cursor: "next", limit: 20, status: "reported" });
  expect(options.getNextPageParam({ nextCursor: "next" })).toBe("next");
});
it("requires a nonempty bounded uploader statement and records a benign review without hiding", async () => {
  render();
  const review = fixture.forms[1] as Form;
  expect(review.validators.onSubmit.safeParse({ reason: "no_violation", note: " " }).success).toBe(
    false,
  );
  expect(
    review.validators.onSubmit.safeParse({ reason: "no_violation", note: "x".repeat(1001) })
      .success,
  ).toBe(false);
  await review.onSubmit({
    value: { reason: "no_violation", note: "  No policy violation found.  " },
  });
  expect(fixture.mutateAsync).toHaveBeenCalledExactlyOnceWith({
    id: "match",
    hidden: false,
    reason: "no_violation",
    note: "No policy violation found.",
  });
});
it("hides cached moderation content on access denial", () => {
  fixture.query.error = { code: "NOT_FOUND" };
  fixture.query.isError = true;
  const html = render();
  expect(html).not.toContain("Published replay");
  expect(html).not.toContain("untrusted");
  expect(html).toContain(enChess.moderation.loadFailed);
});
