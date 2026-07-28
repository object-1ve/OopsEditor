/**
 * Sidebar utility functions
 */
import { invoke } from "@tauri-apps/api/core";
import { base64ToHexView } from "@/utils/hexView";
import { detectLanguage, isPreviewOnlyLanguage } from "@/types";
import { buildTabId } from "@/utils/path";
import { normalizePath } from "@/utils/path";
import type { DefaultFolder } from "@/store/types";

export { normalizePath };

export interface DirEntry {
  path: string;
  name: string;
  is_dir: boolean;
  size: number;
  modified_at: number;
}

export type OpenMode = "text" | "base64";

export const getRenameSelectionEnd = (entryName: string, isDirectory: boolean) => {
  if (isDirectory) return entryName.length;
  const lastDotIndex = entryName.lastIndexOf(".");
  if (lastDotIndex <= 0) return entryName.length;
  return lastDotIndex;
};

export const sortTreeEntries = (
  entries: DirEntry[],
  pinnedFolders: string[],
  defaultFolders: DefaultFolder[],
  sortField: "name" | "modified" = "name",
  sortOrder: "asc" | "desc" = "asc",
) => {
  const pinnedSet = new Set(pinnedFolders.map(normalizePath));
  const defaultPathsSet = new Set(defaultFolders.map((f) => normalizePath(f.path)));

  return [...entries].sort((a, b) => {
    const aPath = normalizePath(a.path);
    const bPath = normalizePath(b.path);

    const aDefault = a.is_dir && defaultPathsSet.has(aPath);
    const bDefault = b.is_dir && defaultPathsSet.has(bPath);
    if (aDefault !== bDefault) return aDefault ? -1 : 1;

    const aPinned = a.is_dir && pinnedSet.has(aPath);
    const bPinned = b.is_dir && pinnedSet.has(bPath);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;

    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;

    let result = 0;
    if (sortField === "modified") {
      result = a.modified_at - b.modified_at;
    } else {
      result = a.name.localeCompare(b.name, "zh-CN");
    }
    return sortOrder === "asc" ? result : -result;
  });
};

export async function openFileTab(
  filePath: string,
  openTab: (tab: import("../../types").FileTab) => void,
  showNotification: (message: string, type?: "info" | "error" | "success") => void,
  fileSize?: number,
  mode: OpenMode = "text",
) {
  try {
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
    const detection = mode === "base64" ? { language: "plaintext" } : detectLanguage(fileName);
    const { language, unsupportedReason } = detection;

    if (language === "unsupported") {
      showNotification(unsupportedReason || `不支持打开该类型的文件: ${fileName}`, "info");
      return;
    }

    let content = "";

    if (mode === "base64") {
      const base64Content = await invoke<string>("read_file_as_base64", { path: filePath });
      content = base64ToHexView(base64Content);
    } else if (!isPreviewOnlyLanguage(language)) {
      content = await invoke<string>("read_file", { path: filePath });
    }

    openTab({
      id: buildTabId(filePath, mode),
      name: mode === "base64" ? `${fileName} [Base64]` : fileName,
      path: filePath,
      language,
      content,
      isDirty: false,
      size: fileSize,
      viewMode: mode,
      isReadOnly: false,
    });
  } catch (err) {
    showNotification(`无法打开文件: ${filePath.split(/[/\\]/).pop()} (${String(err)})`, "error");
  }
}
