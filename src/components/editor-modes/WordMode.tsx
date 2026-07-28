/**
 * Word document preview mode
 */
import WordPreview from "@/components/WordPreview";
import type { EditorModeContext, EditorModeAdapter } from "./types";

function WordModeView({
  activeTab,
  showNotification,
}: Pick<EditorModeContext, "activeTab" | "showNotification">) {
  return (
    <WordPreview
      name={activeTab.name}
      path={activeTab.path}
      showNotification={showNotification}
    />
  );
}

export const wordMode: EditorModeAdapter = {
  id: "word",
  match: (tab) => tab.language === "word",
  render: (context) => (
    <WordModeView
      activeTab={context.activeTab}
      showNotification={context.showNotification}
    />
  ),
};
