/**
 * 搜索范围对象：文件 / 会话 / 文件夹三种范围在界面与请求里走同一形状。
 *
 * 搜索面板的 3 个 tab（固定文件 / 会话 / 文件夹）列出的候选都是 SearchScope，
 * 点击即加入筛选条件、再点移出；发起搜索时由 scopesToRequest 统一翻译成请求参数。
 */
import type { ChatSession } from "@/services/chat";
import { formatChatDateTime } from "@/utils/chatTime";
import { normalizePath } from "@/utils/path";

export type SearchScopeKind = "file" | "session" | "folder";

export interface SearchScope {
  kind: SearchScopeKind;
  /** 文件 / 文件夹的绝对路径；会话为 null */
  path: string | null;
  /** 会话 id；文件 / 文件夹为 null */
  sessionId: number | null;
  /** 界面展示名：文件名 / 会话标题 / 文件夹名 */
  name: string;
  /** hover 提示：完整路径或会话摘要 */
  detail: string;
}

/** 展示名取路径最后一段 */
export function scopeBaseName(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

/** 范围唯一键：文件按路径、文件夹按路径、会话按 id，同一目标只会被加入一次 */
export function scopeKey(scope: SearchScope): string {
  return `${scope.kind}:${scope.path ?? scope.sessionId ?? ""}`;
}

export function createFileScope(path: string): SearchScope {
  return { kind: "file", path, sessionId: null, name: scopeBaseName(path), detail: path };
}

export function createFolderScope(path: string): SearchScope {
  return { kind: "folder", path, sessionId: null, name: scopeBaseName(path), detail: path };
}

export function createSessionScope(session: ChatSession): SearchScope {
  return {
    kind: "session",
    path: null,
    sessionId: session.id,
    name: session.title,
    detail: `最近编辑 ${formatChatDateTime(session.updated_at)} · ${session.message_count} 条消息`,
  };
}

/** 路径是否落在某个文件夹范围内：斜杠与大小写归一后比较（Windows 下大小写不敏感） */
export function isPathInside(path: string, folder: string): boolean {
  const target = normalizePath(path).toLowerCase();
  const base = normalizePath(folder).toLowerCase();
  return target === base || target.startsWith(`${base}/`);
}

export interface ScopeRequest {
  /** 文件域：具体文件（可能不在任何根目录下） */
  onlyPaths: string[];
  /** 文件域：文件夹范围；一个范围都没选时回落到工作区根目录 */
  roots: string[];
  /** 消息域：选中的会话；空数组表示全部会话 */
  sessionIds: number[];
}

function pathsOf(scopes: SearchScope[], kind: SearchScopeKind): string[] {
  return scopes
    .filter((scope) => scope.kind === kind)
    .map((scope) => scope.path)
    .filter((path): path is string => path !== null);
}

/**
 * 选中范围 → 请求参数。
 *
 * 文件域：具体文件走 onlyPaths、文件夹走 roots，两者可同时生效（并集）；
 * 已经落在选中文件夹里的文件不再单独列出 —— 文件夹遍历本来就覆盖它，免得同一文件命中两遍。
 */
export function scopesToRequest(scopes: SearchScope[], workspaceRoots: string[]): ScopeRequest {
  const folders = pathsOf(scopes, "folder");
  const files = pathsOf(scopes, "file").filter(
    (path) => !folders.some((folder) => isPathInside(path, folder)),
  );

  return {
    onlyPaths: files,
    roots: folders.length > 0 ? folders : files.length > 0 ? [] : workspaceRoots,
    sessionIds: scopes
      .filter((scope) => scope.kind === "session")
      .map((scope) => scope.sessionId)
      .filter((id): id is number => id !== null),
  };
}
