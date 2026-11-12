import { createFileRoute } from "@tanstack/react-router";
import { ArenaPage } from "@/components/chess/arena-page";
import { homeSearchSchema } from "@/lib/home-search";

export const Route = createFileRoute("/$lang/_public/")({
  validateSearch: homeSearchSchema,
  component: HomePage,
});
function HomePage() {
  const { tab, game } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ArenaPage
      tab={tab ?? "arena"}
      slug={game}
      onNavigate={(nextTab, slug) => void navigate({ search: { tab: nextTab, game: slug } })}
    />
  );
}
