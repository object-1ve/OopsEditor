/**
 * 桥接模块：允许 App 级别的拖放事件向 Monaco Editor 插入文本。
 *
 * Editor.tsx 在编辑器 mounted 时注册 insert 回调，
 * App.tsx 在文件拖放时发起自定义事件通知 Editor 处理。
 */

type InsertCallback = (text: string) => void;

let _insertFn: InsertCallback | null = null;

export function registerEditorInsert(fn: InsertCallback) {
  _insertFn = fn;
}

export function unregisterEditorInsert() {
  _insertFn = null;
}

export function insertAtCursor(text: string): boolean {
  if (!_insertFn) return false;
  _insertFn(text);
  return true;
}

/* ---- 拖放路径暂存 & 自定义事件 ---- */

/** App 层 Tauri 事件暂存拖入的文件路径，并分派自定义事件 */
export function dispatchFileDrop(paths: string[]) {
  window.dispatchEvent(
    new CustomEvent("file-drop-into-editor", { detail: { paths } }),
  );
}

/* ---- 文件类型辅助 ---- */

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp",
  "tiff", "tif", "avif", "apng", "heic", "heif",
]);

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext ? IMAGE_EXTS.has(ext) : false;
}

export function buildImageSyntax(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  return `![](${normalizedPath})\n`;
}

export function buildLinkSyntax(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const name = normalizedPath.split("/").pop() ?? normalizedPath;
  return `[${name}](${normalizedPath})\n`;
}

/** Tauri 层 onDragDropEvent 落点：检查当前 tab 是否为可编辑的 Markdown */
export function isMarkdownEditable(
  tabs: { id: string; language: string; isPreviewMode?: boolean; isReadOnly?: boolean }[],
  activeTabId: string | null,
): boolean {
  const tab = tabs.find((t) => t.id === activeTabId);
  return Boolean(
    tab &&
    tab.language === "markdown" &&
    !tab.isPreviewMode &&
    !tab.isReadOnly,
  );
}
