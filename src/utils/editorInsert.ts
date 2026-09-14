/**
 * 桥接模块：允许 App 级别的拖放事件向 Monaco Editor 插入文本。
 *
 * Editor.tsx 在编辑器 mounted 时注册 insert 回调，
 * App.tsx 在文件拖放时发起自定义事件通知 Editor 处理。
 */

import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "@/store/editor";

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

/** Rust 侧按内容哈希落盘后的导入结果（字段名与 Rust 结构体一致，snake_case） */
interface AttachmentImportResult {
  /** 所在 Attachment 目录内的文件名 */
  filename: string;
  /** 图片完整路径（正斜杠） */
  path: string;
  /** markdown 中使用的相对引用（相对 md 所在目录） */
  reference: string;
  parent_dir: string;
  save_dir: string;
  /** true = 复用了已存在的图片，本次未写入新文件 */
  reused: boolean;
}

export interface AttachmentImportOutcome {
  filename: string;
  savePath: string;
  reference: string;
  saveDir: string;
  parentDir: string;
  /** 命中了已有图片（内容相同），未产生副本 */
  reused: boolean;
}

/**
 * 将图片导入到 md 文件同级的 Attachment 目录（转换路径）。
 *
 * 文件名由 Rust 侧按内容 sha256 生成（`<原名>-<hash16>.<ext>`），复用范围是 md 文件
 * 所属的侧边栏根目录：同一根目录下（含其它文件夹）相同内容的图片只保留一份，
 * 重复导入会复用已有文件并返回相对引用（如 `../B/Attachment/image-x.png`），
 * 不写副本、不依赖数据库或索引文件。
 *
 * @returns 导入结果，包含文件名、相对引用、目录信息与是否复用
 */
export async function importImageIntoAttachment(
  mdPath: string,
  source: ImageImportSource,
): Promise<AttachmentImportOutcome> {
  const normalizedMdPath = mdPath.replace(/\\/g, "/");
  // 复用范围由 Rust 侧从根目录里挑「层级最深的那个祖先目录」
  const scopeRoots = useEditorStore.getState().rootPaths;

  const result =
    source.type === "file"
      ? await invoke<AttachmentImportResult>("import_image_file", {
          mdPath: normalizedMdPath,
          scopeRoots,
          sourcePath: source.path,
        })
      : await invoke<AttachmentImportResult>("import_image_base64", {
          mdPath: normalizedMdPath,
          scopeRoots,
          data: source.data,
          name: source.name ?? null,
        });

  // 复用时目录内容没变化，无需刷新左侧文件树：
  // 1. 父目录 —— 让新建的 Attachment 目录出现在列表中
  // 2. Attachment 目录 —— 显示刚保存的图片文件
  if (!result.reused) {
    window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: result.parent_dir } }));
    window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: result.save_dir } }));
  }

  return {
    filename: result.filename,
    savePath: result.path,
    reference: result.reference,
    saveDir: result.save_dir,
    parentDir: result.parent_dir,
    reused: result.reused,
  };
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
