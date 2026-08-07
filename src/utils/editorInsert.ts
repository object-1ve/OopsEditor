/**
 * 桥接模块：允许 App 级别的拖放事件向 Monaco Editor 插入文本。
 *
 * Editor.tsx 在编辑器 mounted 时注册 insert 回调，
 * App.tsx 在文件拖放时发起自定义事件通知 Editor 处理。
 */

import { invoke } from "@tauri-apps/api/core";

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

/* ---- 图片导入（转换路径 + 刷新侧边栏） ---- */

export type ImageImportSource =
  | { type: "file"; path: string }
  | { type: "base64"; data: string; name?: string };

/** 若目标路径已存在，追加 _1、_2 … 后缀生成唯一路径 */
async function findUniquePath(basePath: string): Promise<string> {
  if (!(await invoke<boolean>("path_exists", { path: basePath }))) {
    return basePath;
  }
  const lastDot = basePath.lastIndexOf(".");
  const stem = lastDot > 0 ? basePath.slice(0, lastDot) : basePath;
  const ext = lastDot > 0 ? basePath.slice(lastDot) : "";
  for (let i = 1; ; i++) {
    const candidate = `${stem}_${i}${ext}`;
    if (!(await invoke<boolean>("path_exists", { path: candidate }))) {
      return candidate;
    }
  }
}

/**
 * 将图片导入到 md 文件同级的 Attachment 目录（转换路径），
 * 并刷新左侧文件树中对应的文件夹目录显示。
 *
 * @returns 导入结果，包含最终文件名、Attachment 目录与完整保存路径
 */
export async function importImageIntoAttachment(
  mdPath: string,
  source: ImageImportSource,
): Promise<{ filename: string; saveDir: string; savePath: string; parentDir: string }> {
  const normalizedMdPath = mdPath.replace(/\\/g, "/");
  const lastSlash = normalizedMdPath.lastIndexOf("/");
  if (lastSlash < 0) {
    throw new Error("当前文件尚未保存到磁盘，请先保存文件");
  }
  const parentDir = normalizedMdPath.substring(0, lastSlash);
  const saveDir = parentDir + "/Attachment";

  // 生成目标文件名
  let rawName: string;
  if (source.type === "file") {
    rawName = source.path.split(/[/\\]/).pop() || "image.png";
  } else {
    const ext = (source.name || "image.png").split(".").pop() || "png";
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    rawName = `image_${ts}.${ext}`;
  }

  try {
    await invoke("create_dir", { path: saveDir });
  } catch (e) {
    const msg = String(e);
    if (!msg.includes("目录已存在") && !msg.includes("exists")) throw e;
  }

  const savePath = await findUniquePath(`${saveDir}/${rawName}`);
  const filename = savePath.split("/").pop() ?? rawName;

  if (source.type === "file") {
    await invoke("copy_file", { sourcePath: source.path, targetPath: savePath });
  } else {
    await invoke("save_file_from_base64", { path: savePath, content: source.data });
  }

  // 刷新左侧文件树：
  // 1. 父目录 —— 让新建的 Attachment 目录出现在列表中
  // 2. Attachment 目录 —— 显示刚保存的图片文件
  window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: parentDir } }));
  window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: saveDir } }));
  return { filename, saveDir, savePath, parentDir };
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
