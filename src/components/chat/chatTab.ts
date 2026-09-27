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
