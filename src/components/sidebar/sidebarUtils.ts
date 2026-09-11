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

/** 归一化后比较两个路径是否相同（忽略分隔符与盘符大小写差异） */
export const isSamePath = (a: string, b: string): boolean => {
  const normalizedA = normalizePath(a).toLowerCase();
  const normalizedB = normalizePath(b).toLowerCase();
  return normalizedA !== "" && normalizedA === normalizedB;
};

/** 判断 target 是否位于 folder 之内（含 folder 自身） */
export const isPathInside = (target: string, folder: string): boolean => {
  const normalizedTarget = normalizePath(target).toLowerCase();
  const normalizedFolder = normalizePath(folder).toLowerCase();
  if (!normalizedTarget || !normalizedFolder) return false;
  return (
    normalizedTarget === normalizedFolder ||
    normalizedTarget.startsWith(`${normalizedFolder}/`)
  );
};

/**
 * 返回包含该路径的最长工作区根目录（保持根目录在状态中的原始写法，
 * 以便与文件树节点的 data-sidebar-path 完全一致）。
 */
export const findWorkspaceRoot = (target: string, roots: string[]): string | null => {
  let matched: string | null = null;
  roots.forEach((root) => {
    if (!isPathInside(target, root)) return;
    if (matched === null || normalizePath(root).length > normalizePath(matched).length) {
      matched = root;
    }
  });
  return matched;
};

/** 返回 target 相对 root 的中间目录层级（不含文件名），大小写保持 target 原样 */
export const relativeFolderSegments = (target: string, root: string): string[] => {
  const normalizedTarget = normalizePath(target);
  const normalizedRoot = normalizePath(root);
  if (!normalizedRoot || normalizedTarget.length <= normalizedRoot.length) return [];
  // 前缀匹配与大小写无关（Windows 路径），但截取时保留 target 原样
  if (!normalizedTarget.toLowerCase().startsWith(normalizedRoot.toLowerCase())) return [];
  const segments = normalizedTarget
    .slice(normalizedRoot.length)
    .split("/")
    .filter(Boolean);
  segments.pop();
  return segments;
};

export function createTimestampFileName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.md`;
}

export interface DirEntry {
  path: string;
  name: string;
  is_dir: boolean;
  size: number;
  modified_at: number;
}

export type OpenMode = "text" | "base64";

/** 定位高亮目标：variant 交替两个等价类名，保证连续定位同一行时高亮动画可以重播 */
export interface SidebarRevealHighlight {
  path: string;
  variant: number;
}

export const revealFlashClass = (variant: number) =>
  variant % 2 === 0 ? "sidebar-reveal-flash" : "sidebar-reveal-flash-alt";

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

/**
 * Given a desired path, if the file already exists, appends a timestamp suffix
 * in the format `{name}-{YYYY}-{MM}-{DD}_{HH}-{MM}-{SS}.{ext}` to avoid collision.
 */
export async function resolveUniquePath(basePath: string): Promise<string> {
  const lastDot = basePath.lastIndexOf(".");
  const hasExt = lastDot > basePath.lastIndexOf("/") && lastDot > basePath.lastIndexOf("\\");
  const prefix = hasExt ? basePath.slice(0, lastDot) : basePath;
  const ext = hasExt ? basePath.slice(lastDot) : "";

  try {
    if (await invoke<boolean>("path_exists", { path: basePath })) {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      return `${prefix}-${ts}${ext}`;
    }
  } catch {
    // On error, fall back to the original path
    return basePath;
  }
  return basePath;
}

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
