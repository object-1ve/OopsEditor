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

/**
 * 折叠路径里的 `.` 与 `..` 段（纯字符串处理，不访问文件系统）。
 *
 * markdown 里跨文件夹引用是 `../A/Attachment/x.png` 这种形式，而 Tauri 的 asset 协议
 * （SafePathBuf）会拒绝含 `..` 的路径，因此转 asset URL 前必须先折叠成绝对形式。
 */
export function collapsePathSegments(path: string): string {
  if (!path) return "";
  const unified = path.replace(/\\/g, "/");
  // 注意：`C:/...` 也是绝对路径，不能只看开头的斜杠
  const posixRoot = unified.startsWith("/");
  const isAbsolute = posixRoot || /^[a-z]:/i.test(unified);
  const segments: string[] = [];

  for (const segment of unified.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      // 盘符是第 0 段、已是 `..` 的段都不能被抵消；绝对路径越过根时按文件系统语义丢弃
      const last = segments[segments.length - 1];
      const atDrive = segments.length === 1 && /^[a-z]:$/i.test(last ?? "");
      if (segments.length > 0 && last !== ".." && !atDrive) {
        segments.pop();
      } else if (!isAbsolute) {
        segments.push("..");
      }
      continue;
    }
    segments.push(segment);
  }

  return (posixRoot ? "/" : "") + segments.join("/");
}

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
