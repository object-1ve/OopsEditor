/**
 * 侧边栏的虚拟「会话」文件夹。
 *
 * 会话不是工作区里的真实文件：后端把它们存在应用私有目录，这里只是把
 * `get_chat_sessions` 的结果渲染成一个可折叠的分组，点击打开会话标签页。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  MessageSquarePlus,
  MessagesSquare,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEditorStore } from "@/store/editor";
import ContextMenu from "@/components/ContextMenu";
import { exportAllSessionsToJsonl, exportSessionToJsonl } from "@/components/chat/chatExport";
import { formatConversationTime } from "@/utils/chatTime";

const COLLAPSE_KEY = "oops.sidebar.sessionsCollapsed";

export default function SessionsSection() {
  const chatSessions = useEditorStore((s) => s.chatSessions);
  const activeSessionId = useEditorStore((s) => s.chatActiveSessionId);
  const selectChatSession = useEditorStore((s) => s.selectChatSession);
  const createChatSession = useEditorStore((s) => s.createChatSession);
  const renameChatSession = useEditorStore((s) => s.renameChatSession);
  const deleteChatSession = useEditorStore((s) => s.deleteChatSession);
  const showNotification = useEditorStore((s) => s.showNotification);
  const showModal = useEditorStore((s) => s.showModal);

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
  const [menu, setMenu] = useState<{ x: number; y: number; sessionId: number } | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    if (renamingId === null) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renamingId]);

  const startRename = useCallback((sessionId: number, title: string) => {
    setDraft(title);
    setRenamingId(sessionId);
  }, []);

  const commitRename = useCallback(async () => {
    if (renamingId === null) return;
    const sessionId = renamingId;
    setRenamingId(null);
    if (draft.trim()) await renameChatSession(sessionId, draft);
  }, [draft, renameChatSession, renamingId]);

  const items = useMemo(() => {
    if (!menu) return [];
    const session = chatSessions.find((item) => item.id === menu.sessionId);
    if (!session) return [];
    return [
      {
        label: "重命名会话",
        icon: <Pencil size={14} />,
        onClick: () => startRename(session.id, session.title),
      },
      {
        label: "导出为 JSONL...",
        icon: <Download size={14} />,
        onClick: () => void exportSessionToJsonl(session, showNotification),
      },
      { separator: true, label: "", onClick: () => {} },
      {
        label: "删除会话",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () =>
          showModal({
            title: "删除会话",
            message: `确定要永久删除会话「${session.title}」吗？此操作无法撤销。`,
            kind: "danger",
            onConfirm: () => void deleteChatSession(session.id),
          }),
      },
    ];
  }, [chatSessions, deleteChatSession, menu, showModal, showNotification, startRename]);

  return (
    <div className="select-none">
      <div className="flex items-center gap-1 px-2 h-7 text-[11px] font-medium text-text-muted">
        <button
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 hover:bg-surface/40 hover:text-text-secondary transition-colors cursor-pointer"
          title={collapsed ? "展开会话" : "折叠会话"}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <MessagesSquare size={12} />
          <span>会话</span>
          <span className="tabular-nums text-text-muted/70">{chatSessions.length}</span>
        </button>
        <button
          onClick={() => void createChatSession()}
          className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer"
          title="新建会话"
        >
          <MessageSquarePlus size={12} />
        </button>
        <button
          onClick={() => void exportAllSessionsToJsonl(showNotification)}
          className="p-1 rounded hover:bg-surface text-text-muted hover:text-accent transition-colors cursor-pointer disabled:opacity-40"
          title="导出全部会话为 JSONL..."
          disabled={chatSessions.length === 0}
        >
          <Download size={12} />
        </button>
      </div>

      {!collapsed && (
        <div className="pb-1">
          {chatSessions.length === 0 ? (
            <div className="px-3 py-1.5 text-[11px] text-text-muted/70">还没有会话</div>
          ) : (
            chatSessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const isRenaming = session.id === renamingId;
              return (
                <div
                  key={session.id}
                  onClick={() => {
                    if (!isRenaming) void selectChatSession(session.id);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ x: event.clientX, y: event.clientY, sessionId: session.id });
                  }}
                  className={`mx-1 flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-[12px] transition-colors ${
                    isActive
                      ? "bg-surface text-accent font-medium"
                      : "text-text-secondary hover:bg-surface/30 hover:text-text"
                  }`}
                >
                  <MessagesSquare size={12} className="shrink-0 text-accent/70" />
                  {isRenaming ? (
                    <input
                      ref={inputRef}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={() => void commitRename()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void commitRename();
                        if (event.key === "Escape") setRenamingId(null);
                      }}
                      className="min-w-0 flex-1 rounded border border-accent/50 bg-secondary px-1 py-0 text-[12px] focus:outline-none"
                    />
                  ) : (
                    <>
                      <span className="truncate" title={session.title}>
                        {session.title}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-text-muted/70">
                        {session.message_count} 条消息 · {formatConversationTime(session.updated_at)}
                      </span>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {menu && items.length > 0 && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
