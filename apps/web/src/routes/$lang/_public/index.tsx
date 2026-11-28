import { createFileRoute } from "@tanstack/react-router";
import { ArenaPage } from "@/components/chess/arena-page";
import { homeSearchSchema } from "@/lib/home-search";

export const Route = createFileRoute("/$lang/_public/")({
  validateSearch: homeSearchSchema,
  component: HomePage,
});
function HomePage() {
  const { tab, game, category, ...resultsFilter } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ArenaPage
      tab={tab ?? "arena"}
      slug={game}
      category={category}
      resultsFilter={resultsFilter}
      onResultsFilter={(filter) =>
        void navigate({ search: { ...filter, tab: "leaderboard" }, resetScroll: false })
      }
      onCategory={(next) =>
        void navigate({
          search: (previous) => ({ ...previous, category: next, game: undefined }),
          resetScroll: false,
        })
      }
      onNavigate={(nextTab, slug) =>
        void navigate({
          search: (previous) => ({ ...previous, tab: nextTab, game: slug }),
          resetScroll: nextTab !== (tab ?? "arena") || Boolean(slug),
        })
      }
    />
  );
}
