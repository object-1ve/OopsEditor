/**
 * Editor modes - resolver and exports
 *
 * Each mode is a separate file that exports an EditorModeAdapter.
 * This index combines them and provides the resolveEditorMode function.
 */
import { lazy, Suspense } from "react";
import type { FileTab } from "@/types";
import type { EditorModeAdapter } from "./types";

import { imageMode } from "./ImageMode";
import { pdfMode } from "./PdfMode";
import { wordMode } from "./WordMode";
import { sqliteMode } from "./SqliteMode";
import { excelMode } from "./ExcelMode";
import { notebookMode } from "./NotebookMode";
import { markdownPreviewMode } from "./MarkdownMode";
import { base64Mode } from "./Base64Mode";
import { textMode } from "./TextMode";

export type { EditorModeContext, EditorModeAdapter, SharedContextMenuItem, OnMount } from "./types";
export { usePreviewResource, useMonacoScrollMemory } from "./sharedHooks";
export { decodeHexPreview, getHexOffsetLabel } from "./hexUtils";
export { MarkdownPreviewPane } from "./MarkdownMode";

/**
 * 即时渲染模式带到 Vditor（Lute、工具栏、代码高亮），单独成块懒加载：
 * 只有真正切到该模式的文档才付这份下载与解析成本。
 */
const LazyInstantRenderModeView = lazy(() =>
  import("./InstantRenderMode").then((module) => ({
    default: module.InstantRenderModeView,
  })),
);

const instantRenderMode: EditorModeAdapter = {
  id: "markdown-instant",
  match: (tab) => tab.language === "markdown" && Boolean(tab.isInstantRenderMode),
  render: (context) => (
    <Suspense fallback={<div className="h-full bg-primary" />}>
      <LazyInstantRenderModeView
        key={context.activeTab.id}
        activeTab={context.activeTab}
        onChange={context.onChange}
        toggleInstantRenderMode={context.toggleInstantRenderMode}
        showNotification={context.showNotification}
        saveActiveTab={context.saveActiveTab}
      />
    </Suspense>
  ),
};

export const editorModes: EditorModeAdapter[] = [
  imageMode,
  pdfMode,
  wordMode,
  sqliteMode,
  excelMode,
  notebookMode,
  markdownPreviewMode,
  instantRenderMode,
  base64Mode,
  textMode,
];

export function resolveEditorMode(tab: FileTab) {
  return editorModes.find((mode) => mode.match(tab)) ?? textMode;
}
