/**
 * 会话视图：占据原本的文件编辑区（消息流 + 输入区）。
 *
 * 会话列表在左侧边栏的「会话」标签里，这里只渲染当前会话的消息流，
 * 与微信的两栏布局一致：左栏会话列表、右栏对话内容。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Copy, MessagesSquare, Trash2, X } from "lucide-react";
import { useEditorStore } from "@/store/editor";
import { getChatMessages } from "@/services/chat";
import { formatChatDateTime, formatDayDivider, needsTimeDivider } from "@/utils/chatTime";
import ChatComposer from "./ChatComposer";
import MessageBubble from "./MessageBubble";
import type { ChatMessageActions } from "./MessageBubble";
import { openChatFile, previewChatImage, revealChatFile } from "./chatOpen";

export default function ChatView() {
  const sessions = useEditorStore((s) => s.chatSessions);
  const activeSessionId = useEditorStore((s) => s.chatActiveSessionId);
  const messages = useEditorStore((s) => s.chatMessages);
  const isSending = useEditorStore((s) => s.chatIsSending);
  const isLoading = useEditorStore((s) => s.chatIsLoading);
  const loadChatSessions = useEditorStore((s) => s.loadChatSessions);
  const selectChatSession = useEditorStore((s) => s.selectChatSession);
  const createChatSession = useEditorStore((s) => s.createChatSession);
  const sendChatText = useEditorStore((s) => s.sendChatText);
  const sendChatFiles = useEditorStore((s) => s.sendChatFiles);
  const sendChatImages = useEditorStore((s) => s.sendChatImages);
  const sendChatClipboardImage = useEditorStore((s) => s.sendChatClipboardImage);
  const editChatMessage = useEditorStore((s) => s.editChatMessage);
  const deleteChatMessage = useEditorStore((s) => s.deleteChatMessage);
  const deleteChatSession = useEditorStore((s) => s.deleteChatSession);
  const showNotification = useEditorStore((s) => s.showNotification);
  const setActiveView = useEditorStore((s) => s.setActiveView);
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

  // 首次进入：拉列表并自动选中第一个会话
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await loadChatSessions();
      if (cancelled) return;
      useEditorStore.setState({ chatIsLoading: false });
      if (list.length > 0 && useEditorStore.getState().chatActiveSessionId === null) {
        void selectChatSession(list[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadChatSessions, selectChatSession]);

  // 新消息 / 切换会话后滚到底部
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, activeSessionId]);

  const messageActions: ChatMessageActions = useMemo(
    () => ({
      onEdit: (id, content) => editChatMessage(id, content),
      onDelete: (id) => deleteChatMessage(id),
      onOpenFile: (path, displayName) => void openChatFile(path, showNotification, displayName),
      onRevealFile: (path) => revealChatFile(path, showNotification),
      onPreviewImage: (path, name) => previewChatImage(path, name ?? undefined),
    }),
    [deleteChatMessage, editChatMessage, showNotification],
  );

  /** 复制整个会话（含创建时间 / 最近编辑时间） */
  const copyConversation = useCallback(async () => {
    if (!activeSession) return;
    try {
      const list = messages.length > 0 ? messages : await getChatMessages(activeSession.id);
      const lines = list.map((message) => {
        const sender = message.role === "me" ? "我" : "对方";
        return `[${formatChatDateTime(message.created_at)}] ${sender}: ${message.content || message.file_name || ""}`;
      });
      const header = `# ${activeSession.title}\n创建时间: ${formatChatDateTime(activeSession.created_at)}\n最近编辑: ${formatChatDateTime(activeSession.updated_at)}\n\n`;
      await navigator.clipboard.writeText(header + lines.join("\n"));
      showNotification("会话内容已复制到剪贴板", "success");
    } catch (err) {
      showNotification(`复制失败: ${String(err)}`, "error");
    }
  }, [activeSession, messages, showNotification]);

  if (!activeSession) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center bg-deepest">
        <div className="w-14 h-14 rounded-2xl bg-surface border border-border flex items-center justify-center text-text-muted">
          <MessagesSquare size={22} />
        </div>
        <p className="text-sm text-text-secondary">
          {isLoading ? "正在加载会话..." : "还没有会话"}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void createChatSession()}
            className="px-3 py-1.5 rounded-lg bg-accent text-white text-[12px] hover:bg-accent-bright transition-colors cursor-pointer"
          >
            新建会话
          </button>
          <button
            onClick={() => setActiveView("files")}
            className="px-3 py-1.5 rounded-lg bg-surface text-text-secondary text-[12px] hover:bg-hover transition-colors cursor-pointer"
          >
            返回编辑器
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0 min-h-0">
      {/* 会话头部：标题 + 创建/最近编辑时间 */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-border shrink-0 bg-deepest">
        <div className="flex-1 min-w-0">
          <div className="truncate text-[13px] font-medium text-text-primary">
            {activeSession.title}
          </div>
          <div className="text-[10px] text-text-muted/85 tabular-nums truncate">
            创建 {formatChatDateTime(activeSession.created_at)} · 最近编辑{" "}
            {formatChatDateTime(activeSession.updated_at)} · {activeSession.message_count} 条消息
          </div>
        </div>
        <button
          onClick={() => void copyConversation()}
          title="复制整个会话"
          className="p-1.5 rounded-lg text-text-muted hover:text-accent hover:bg-surface transition-colors cursor-pointer"
        >
          <Copy size={13} />
        </button>
        <button
          onClick={() => void deleteChatSession(activeSession.id)}
          title="删除当前会话"
          className="p-1.5 rounded-lg text-text-muted hover:text-error hover:bg-error/10 transition-colors cursor-pointer"
        >
          <Trash2 size={13} />
        </button>
        <button
          onClick={() => setActiveView("files")}
          title="返回编辑器"
          className="p-1.5 rounded-lg text-text-muted hover:text-accent hover:bg-surface transition-colors cursor-pointer"
        >
          <X size={13} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto py-3 space-y-2">
        {messages.length === 0 ? (
          <p className="text-center text-[12px] text-text-muted py-8">
            还没有消息，发送第一条吧
          </p>
        ) : (
          messages.map((message, index) => {
            const previous = index > 0 ? messages[index - 1].created_at : null;
            return (
              <div key={message.id}>
                {needsTimeDivider(previous, message.created_at) && (
                  <div className="flex justify-center my-2">
                    <span className="px-2 py-0.5 rounded-full bg-surface text-[10px] text-text-muted/85">
                      {formatDayDivider(message.created_at)}
                    </span>
                  </div>
                )}
                <MessageBubble message={message} actions={messageActions} />
              </div>
            );
          })
        )}
      </div>

      <ChatComposer
        disabled={false}
        isSending={isSending}
        onSendText={sendChatText}
        onSendFiles={sendChatFiles}
        onSendImages={sendChatImages}
        onSendClipboardImage={sendChatClipboardImage}
        onError={(message) => showNotification(message, "error")}
      />
    </div>
  );
}
