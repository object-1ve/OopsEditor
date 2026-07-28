/**
 * Image preview mode
 */
import ImagePreview from "@/components/ImagePreview";
import { usePreviewResource } from "./sharedHooks";
import type { EditorModeContext, EditorModeAdapter } from "./types";

function ImageModeView({
  activeTab,
  showNotification,
}: Pick<EditorModeContext, "activeTab" | "showNotification">) {
  const { previewUrl } = usePreviewResource(activeTab, showNotification);

  return previewUrl ? (
    <ImagePreview
      src={previewUrl}
      name={activeTab.name}
      path={activeTab.path}
    />
  ) : (
    <div className="flex-1 h-full flex items-center justify-center bg-deepest">
      <div className="text-text-muted">无法加载图片</div>
    </div>
  );
}

export const imageMode: EditorModeAdapter = {
  id: "image",
  match: (tab) => tab.language === "image",
  render: (context) => (
    <ImageModeView
      activeTab={context.activeTab}
      showNotification={context.showNotification}
    />
  ),
};
