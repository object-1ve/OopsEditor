/**
 * 共享路径工具函数
 * 提取 normalizePath 供各模块复用，保障盘符大小写和斜杠统一。
 */

export function normalizePath(p: string): string {
  if (!p) return "";
  // 统一斜杠，移除末尾斜杠，并统一盘符为大写（Windows）
  let normalized = p.replace(/\\/g, "/").replace(/\/$/, "");
  if (/^[a-z]:/i.test(normalized)) {
    normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return normalized;
}

export const normalizeUniquePaths = (paths: string[]) =>
  Array.from(new Set(paths.map(normalizePath).filter(Boolean)));

export interface PinnedFile {
  name: string;
  path: string;
}

export const normalizePinnedFiles = (files: PinnedFile[]) => {
  const seen = new Set<string>();
  const normalizedFiles: PinnedFile[] = [];

  for (const file of files) {
    const normalizedPath = normalizePath(file.path);
    if (!normalizedPath || seen.has(normalizedPath)) {
      continue;
    }

    seen.add(normalizedPath);
    normalizedFiles.push({
      name: file.name || file.path.split(/[/\\]/).pop() || normalizedPath,
      path: file.path,
    });
  }

  return normalizedFiles;
};

export type OpenMode = "text" | "base64";

export const buildTabId = (filePath: string, mode: OpenMode) =>
  mode === "base64" ? `${filePath}#base64` : filePath;
