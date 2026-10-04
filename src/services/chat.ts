/**
 * 会话面板数据访问层：包装 Tauri 命令，统一类型与错误处理。
 */
import { invoke } from "@tauri-apps/api/core";

export type ChatRole = "me" | "other";
export type ChatMessageKind = "text" | "file" | "image";

export interface ChatSession {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message: string;
}

export interface ChatMessage {
  id: number;
  session_id: number;
  role: ChatRole;
  kind: ChatMessageKind;
  content: string;
  file_name: string | null;
  file_path: string | null;
  file_size: number;
  created_at: string;
  updated_at: string;
  edited: boolean;
  /** 收藏标记（只影响展示：气泡外框高亮 + 星星） */
  favorited: boolean;
}

export interface NewChatMessage {
  session_id: number;
  role?: ChatRole;
  kind?: ChatMessageKind;
  content?: string;
  file_name?: string | null;
  file_path?: string | null;
  file_size?: number;
}

export interface ChatAttachment {
  name: string;
  path: string;
  size: number;
}

/** 发送文件：只记录本地路径，不复制（后端只做一次 stat 校验） */
export function sendChatFileMessage(
  sessionId: number,
  sourcePath: string,
  content = "",
): Promise<ChatMessage> {
  return invoke("add_chat_file_message", { sourcePath, sessionId, role: "me", content });
}

/** 发送图片：缓存一份副本后写入 image 消息 */
export function sendChatImageMessage(
  sessionId: number,
  sourcePath: string,
  content = "",
): Promise<ChatMessage> {
  return invoke("add_chat_image_message", { sourcePath, sessionId, role: "me", content });
}

/** 发送剪贴板图片（base64）：缓存副本后写入 image 消息 */
export function sendChatImageMessageBase64(
  sessionId: number,
  data: string,
  name?: string,
  content = "",
): Promise<ChatMessage> {
  return invoke("add_chat_image_message_base64", {
    data,
    sessionId,
    name: name ?? null,
    role: "me",
    content,
  });
}

/** 判断路径是否为图片文件（按扩展名） */
export function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase();
  return !!ext && IMAGE_EXTENSIONS.has(ext);
}

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff", "tif", "avif",
]);

export function getChatSessions(): Promise<ChatSession[]> {
  return invoke("get_chat_sessions");
}

export function createChatSession(title?: string): Promise<ChatSession> {
  return invoke("add_chat_session", { title: title ?? null });
}

export function renameChatSession(id: number, title: string): Promise<ChatSession> {
  return invoke("rename_chat_session", { id, title });
}

export function deleteChatSession(id: number): Promise<void> {
  return invoke("delete_chat_session", { id });
}

export function getChatMessages(sessionId: number): Promise<ChatMessage[]> {
  return invoke("get_chat_messages", { sessionId });
}

export function sendChatMessage(message: NewChatMessage): Promise<ChatMessage> {
  return invoke("add_chat_message", { message });
}

export function editChatMessage(id: number, content: string): Promise<ChatMessage> {
  return invoke("update_chat_message", { id, content });
}

export function deleteChatMessage(id: number): Promise<void> {
  return invoke("delete_chat_message", { id });
}

/** 收藏 / 取消收藏消息（只改标记，不动编辑时间与会话排序） */
export function setChatMessageFavorite(id: number, favorited: boolean): Promise<ChatMessage> {
  return invoke("set_chat_message_favorite", { id, favorited });
}

