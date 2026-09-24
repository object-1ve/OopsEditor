/**
 * 会话 slice：会话列表 / 当前会话消息 / 发送与编辑。
 *
 * 侧边栏的会话列表与主编辑区的消息流是两个独立的组件树，状态放在 store 里共享，
 * 避免两边各自拉取导致「列表的最近编辑时间」与「消息流」不一致。
 */
import type { StateCreator } from "zustand";
import type { EditorState } from "@/store/types";
import {
  createChatSession,
  deleteChatMessage,
  deleteChatSession,
  editChatMessage,
  getChatMessages,
  getChatSessions,
  renameChatSession,
  sendChatMessage,
  type ChatAttachment,
  type ChatMessage,
  type ChatSession,
} from "@/services/chat";

export const createChatSlice: StateCreator<
  EditorState,
  [],
  [],
  Pick<
    EditorState,
    | "chatSessions"
    | "chatActiveSessionId"
    | "chatMessages"
    | "chatIsLoading"
    | "chatIsSending"
    | "loadChatSessions"
    | "selectChatSession"
    | "createChatSession"
    | "renameChatSession"
    | "deleteChatSession"
    | "sendChatText"
    | "sendChatAttachment"
    | "editChatMessage"
    | "deleteChatMessage"
  >
> = (set, get) => ({
  chatSessions: [],
  chatActiveSessionId: null,
  chatMessages: [],
  chatIsLoading: true,
  chatIsSending: false,

  loadChatSessions: async () => {
    try {
      const sessions = await getChatSessions();
      set({ chatSessions: sessions });
      return sessions;
    } catch (err) {
      get().showNotification(`加载会话失败: ${String(err)}`, "error");
      return [];
    }
  },

  /** 切换会话并拉取其消息；同时刷新列表上的最近编辑时间 */
  selectChatSession: async (sessionId: number) => {
    set({ chatActiveSessionId: sessionId });
    try {
      const messages = await getChatMessages(sessionId);
      // 拉取期间用户可能又切走了，避免旧结果覆盖新会话
      if (get().chatActiveSessionId !== sessionId) return;
      set({ chatMessages: messages });
      await get().loadChatSessions();
    } catch (err) {
      get().showNotification(`加载消息失败: ${String(err)}`, "error");
    }
  },

  createChatSession: async () => {
    try {
      const session = await createChatSession();
      set((state) => ({
        chatSessions: [session, ...state.chatSessions],
        chatActiveSessionId: session.id,
        chatMessages: [],
      }));
      get().setActiveView("chat");
      return session;
    } catch (err) {
      get().showNotification(`新建会话失败: ${String(err)}`, "error");
      return null;
    }
  },

  renameChatSession: async (id: number, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const updated = await renameChatSession(id, trimmed);
      set((state) => ({
        chatSessions: state.chatSessions.map((s) => (s.id === id ? updated : s)),
      }));
    } catch (err) {
      get().showNotification(`重命名失败: ${String(err)}`, "error");
    }
  },

  deleteChatSession: async (id: number) => {
    const target = get().chatSessions.find((s) => s.id === id);
    try {
      await deleteChatSession(id);
      const remaining = get().chatSessions.filter((s) => s.id !== id);
      const wasActive = get().chatActiveSessionId === id;
      set({
        chatSessions: remaining,
        chatActiveSessionId: wasActive ? (remaining[0]?.id ?? null) : get().chatActiveSessionId,
        chatMessages: wasActive ? [] : get().chatMessages,
      });
      if (wasActive && remaining[0]) {
        await get().selectChatSession(remaining[0].id);
      }
      get().showNotification(`已删除会话「${target?.title ?? id}」`, "success");
    } catch (err) {
      get().showNotification(`删除会话失败: ${String(err)}`, "error");
    }
  },

  sendChatText: async (text: string) => {
    const sessionId = get().chatActiveSessionId;
    if (sessionId === null) return;
    set({ chatIsSending: true });
    try {
      await sendChatMessage({ session_id: sessionId, role: "me", kind: "text", content: text });
      await get().selectChatSession(sessionId);
    } catch (err) {
      get().showNotification(`发送失败: ${String(err)}`, "error");
      throw err;
    } finally {
      set({ chatIsSending: false });
    }
  },

  sendChatAttachment: async (
    attachment: ChatAttachment,
    kind: "file" | "image",
    caption: string,
  ) => {
    const sessionId = get().chatActiveSessionId;
    if (sessionId === null) return;
    set({ chatIsSending: true });
    try {
      await sendChatMessage({
        session_id: sessionId,
        role: "me",
        kind,
        content: caption,
        file_name: attachment.name,
        file_path: attachment.path,
        file_size: attachment.size,
      });
      await get().selectChatSession(sessionId);
    } catch (err) {
      get().showNotification(`发送附件失败: ${String(err)}`, "error");
      throw err;
    } finally {
      set({ chatIsSending: false });
    }
  },

  editChatMessage: async (id: number, content: string) => {
    const sessionId = get().chatActiveSessionId;
    try {
      await editChatMessage(id, content);
      if (sessionId !== null) await get().selectChatSession(sessionId);
    } catch (err) {
      get().showNotification(`编辑消息失败: ${String(err)}`, "error");
    }
  },

  deleteChatMessage: async (id: number) => {
    const sessionId = get().chatActiveSessionId;
    try {
      await deleteChatMessage(id);
      if (sessionId !== null) await get().selectChatSession(sessionId);
    } catch (err) {
      get().showNotification(`删除消息失败: ${String(err)}`, "error");
    }
  },
});
