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

/** 把磁盘文件复制进会话附件目录；同内容复用已有副本 */
export function storeChatFile(sourcePath: string, name?: string): Promise<ChatAttachment> {
  return invoke("store_chat_file", { sourcePath, name: name ?? null });
}

/** 把 base64 内容（剪贴板图片等）写入会话附件目录 */
export function storeChatBase64(data: string, name?: string): Promise<ChatAttachment> {
  return invoke("store_chat_base64", { data, name: name ?? null });
}
