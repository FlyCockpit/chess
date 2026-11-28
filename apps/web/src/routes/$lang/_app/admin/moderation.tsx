import { createFileRoute } from "@tanstack/react-router";
import { ChessModerationView } from "@/components/admin/chess-moderation-view";

export const Route = createFileRoute("/$lang/_app/admin/moderation")({
  staticData: { pendingShape: "list", pendingWidth: "wide" },
  component: AdminModerationPage,
});

function AdminModerationPage() {
  return <ChessModerationView />;
}
