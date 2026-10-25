/**
 * 会话标签的 id / 伪路径约定。
 *
 * 会话以标签页形式与文件标签混排在顶栏：id 与 path 都由 sessionId 推导，
 * 两者保持 `chat:<sessionId>` 形态，恢复持久化会话时靠前缀识别。
 */
export const CHAT_TAB_ID_PREFIX = "chat:";

export function chatTabId(sessionId: number): string {
  return `${CHAT_TAB_ID_PREFIX}${sessionId}`;
}

/** 从标签 path / id 还原 sessionId；非会话标签返回 null */
export function sessionIdFromChatTabPath(path: string): number | null {
  if (!path.startsWith(CHAT_TAB_ID_PREFIX)) return null;
  const id = Number(path.slice(CHAT_TAB_ID_PREFIX.length));
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** 判断目录是否是工作区内的 `.oops/sessions` */
export function isWorkspaceChatSessionDir(dir: string): boolean {
  return /(?:^|\/)\.oops\/sessions\/?$/i.test(dir.replace(/\\/g, "/"));
}

/** 会话目录的父目录（`.oops`），用于创建后展开文件树 */
export function chatSessionParentDir(dir: string): string {
  return dir.replace(/[\\/][^\\/]+$/, "");
}

/**
 * 从文件树里的会话文件路径还原 sessionId。
 * 只认 `<root>/.oops/sessions/<id>.jsonl`，避免把普通 JSONL 当会话文件。
 */
export function sessionIdFromSessionFilePath(path: string): number | null {
  const normalized = path.replace(/\\/g, "/");
  const match = /(?:^|\/)\.oops\/sessions\/(\d+)\.jsonl$/i.exec(normalized);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}
