/**
 * PDF preview mode
 */
import { usePreviewResource } from "./sharedHooks";
import type { EditorModeContext, EditorModeAdapter } from "./types";

function PdfModeView({
  activeTab,
  showNotification,
}: Pick<EditorModeContext, "activeTab" | "showNotification">) {
  const { previewUrl, previewError } = usePreviewResource(activeTab, showNotification);

  return previewUrl ? (
    <div className="flex-1 h-full bg-deepest p-4">
      <div className="h-full overflow-hidden rounded-xl border border-border bg-white shadow-xl">
        <iframe
          src={previewUrl}
          title={activeTab.name}
          className="h-full w-full"
        />
      </div>
    </div>
  ) : (
    <div className="flex-1 h-full flex items-center justify-center bg-deepest">
      <div className="text-text-muted">{previewError ?? "无法加载 PDF"}</div>
    </div>
  );
}

export const pdfMode: EditorModeAdapter = {
  id: "pdf",
  match: (tab) => tab.language === "pdf",
  render: (context) => (
    <PdfModeView
      activeTab={context.activeTab}
      showNotification={context.showNotification}
    />
  ),
};
