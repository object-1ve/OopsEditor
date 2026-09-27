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
  sendChatFileMessage,
  sendChatImageMessage,
  sendChatImageMessageBase64,
  sendChatMessage,
  type ChatMessage,
  type ChatSession,
} from "@/services/chat";
import { chatTabId } from "@/components/chat/chatTab";
import { formatTimestampName } from "@/utils/format";

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
    | "sendChatFiles"
    | "sendChatImages"
    | "sendChatClipboardImage"
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
    set({ chatIsLoading: true });
    try {
      const sessions = await getChatSessions();
      set({ chatSessions: sessions });
      return sessions;
    } catch (err) {
      get().showNotification(`加载会话失败: ${String(err)}`, "error");
      return [];
    } finally {
      set({ chatIsLoading: false });
    }
  },

  /** 切换会话并拉取其消息；以顶部标签页形式打开，同时刷新列表上的最近编辑时间 */
  selectChatSession: async (sessionId: number) => {
    get().openChatSessionTab(sessionId);
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
      // 默认标题用时间戳（与「新建文件」同一口径）；用户可在列表里右键重命名
      const session = await createChatSession(formatTimestampName());
      set((state) => ({
        chatSessions: [session, ...state.chatSessions],
        chatActiveSessionId: session.id,
        chatMessages: [],
      }));
      get().openChatSessionTab(session.id);
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
      // 会话没了，对应的顶部标签页一并关闭
      get().closeTab(chatTabId(id));
      const remaining = get().chatSessions.filter((s) => s.id !== id);
      const wasActive = get().chatActiveSessionId === id;
      set({
        chatSessions: remaining,
        chatActiveSessionId: wasActive ? (remaining[0]?.id ?? null) : get().chatActiveSessionId,
        chatMessages: wasActive ? [] : get().chatMessages,
      });
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

  /** 发送文件：后端只记录路径（不复制），说明文字附在最后一条 */
  sendChatFiles: async (paths: string[], caption: string) => {
    const sessionId = get().chatActiveSessionId;
    if (sessionId === null || paths.length === 0) return;
    set({ chatIsSending: true });
    try {
      for (let i = 0; i < paths.length; i += 1) {
        const isLast = i === paths.length - 1;
        await sendChatFileMessage(sessionId, paths[i], isLast ? caption : "");
      }
      await get().selectChatSession(sessionId);
    } catch (err) {
      get().showNotification(`发送文件失败: ${String(err)}`, "error");
      throw err;
    } finally {
      set({ chatIsSending: false });
    }
  },

  /** 发送图片：缓存副本后入库（缩略图需要稳定路径） */
  sendChatImages: async (paths: string[], caption: string) => {
    const sessionId = get().chatActiveSessionId;
    if (sessionId === null || paths.length === 0) return;
    set({ chatIsSending: true });
    try {
      for (let i = 0; i < paths.length; i += 1) {
        const isLast = i === paths.length - 1;
        await sendChatImageMessage(sessionId, paths[i], isLast ? caption : "");
      }
      await get().selectChatSession(sessionId);
    } catch (err) {
      get().showNotification(`发送图片失败: ${String(err)}`, "error");
      throw err;
    } finally {
      set({ chatIsSending: false });
    }
  },

  /** 发送剪贴板里的图片（base64） */
  sendChatClipboardImage: async (base64: string, name: string, caption: string) => {
    const sessionId = get().chatActiveSessionId;
    if (sessionId === null) return;
    set({ chatIsSending: true });
    try {
      await sendChatImageMessageBase64(sessionId, base64, name, caption);
      await get().selectChatSession(sessionId);
    } catch (err) {
      get().showNotification(`发送图片失败: ${String(err)}`, "error");
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
