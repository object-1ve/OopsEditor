/**
 * 会话列表：按最近编辑时间倒序，支持搜索、新建、重命名、删除。
 */
import { useCallback, useMemo, useState } from "react";
import { MessageSquarePlus, PencilLine, RotateCw, Search, Trash2 } from "lucide-react";
import ContextMenu from "@/components/ContextMenu";
import { useEditorStore } from "@/store/editor";
import type { ChatSession } from "@/services/chat";
import { getChatMessages } from "@/services/chat";
import { formatChatDateTime, formatConversationTime } from "@/utils/chatTime";

export default function ConversationList() {
  const sessions = useEditorStore((s) => s.chatSessions);
  const activeSessionId = useEditorStore((s) => s.chatActiveSessionId);
  const isLoading = useEditorStore((s) => s.chatIsLoading);
  const loadChatSessions = useEditorStore((s) => s.loadChatSessions);
  const selectChatSession = useEditorStore((s) => s.selectChatSession);
  const createSession = useEditorStore((s) => s.createChatSession);
  const renameSession = useEditorStore((s) => s.renameChatSession);
  const deleteSession = useEditorStore((s) => s.deleteChatSession);
  const showNotification = useEditorStore((s) => s.showNotification);
  const [searchQuery, setSearchQuery] = useState("");
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; session: ChatSession } | null>(null);

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter(
      (session) =>
        session.title.toLowerCase().includes(query) ||
        session.last_message.toLowerCase().includes(query),
    );
  }, [searchQuery, sessions]);

  const copyConversation = useCallback(
    async (session: ChatSession) => {
      try {
        const messages = await getChatMessages(session.id);
        const lines = messages.map((message) => {
          const sender = message.role === "me" ? "我" : "对方";
          return `[${formatChatDateTime(message.created_at)}] ${sender}: ${message.content || message.file_name || ""}`;
        });
        const header = `# ${session.title}\n创建时间: ${formatChatDateTime(session.created_at)}\n最近编辑: ${formatChatDateTime(session.updated_at)}\n\n`;
        await navigator.clipboard.writeText(header + lines.join("\n"));
        showNotification("会话内容已复制到剪贴板", "success");
      } catch (err) {
        showNotification(`复制失败: ${String(err)}`, "error");
      }
    },
    [showNotification],
  );

  return (
    <div className="flex-1 flex flex-col bg-deepest min-h-0 min-w-0">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border shrink-0">
        <div className="relative flex-1 min-w-0">
          <Search
            size={11}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索会话"
            className="w-full pl-6 pr-2 py-1 rounded-lg bg-surface text-[11px] text-text-primary placeholder:text-text-muted/85 outline-none focus:ring-1 focus:ring-accent/50"
          />
        </div>
        <button
          onClick={() => void createSession()}
          title="新建会话"
          className="p-1.5 rounded-lg text-text-muted hover:text-accent hover:bg-surface transition-colors cursor-pointer shrink-0"
        >
          <MessageSquarePlus size={13} />
        </button>
        <button
          onClick={() => void loadChatSessions()}
          title="刷新列表"
          className="p-1.5 rounded-lg text-text-muted hover:text-accent hover:bg-surface transition-colors cursor-pointer shrink-0"
        >
          <RotateCw size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <p className="text-[11px] text-text-muted">
              {isLoading ? "正在加载会话..." : searchQuery ? "没有匹配的会话" : "还没有会话"}
            </p>
            {!isLoading && !searchQuery && (
              <button
                onClick={() => void createSession()}
                className="px-3 py-1 rounded-lg bg-accent text-white text-[11px] hover:bg-accent-bright transition-colors cursor-pointer"
              >
                新建会话
              </button>
            )}
          </div>
        ) : (
          filtered.map((session) => {
            const isActive = session.id === activeSessionId;
            const isEditing = editing?.id === session.id;
            return (
              <div
                key={session.id}
                onClick={() => !isEditing && void selectChatSession(session.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenu({ x: e.clientX, y: e.clientY, session });
                }}
                className={`w-full px-2.5 py-2 cursor-pointer border-l-2 transition-colors ${
                  isActive ? "bg-surface/70 border-l-accent" : "border-l-transparent hover:bg-surface/30"
                }`}
                title={`创建于 ${formatChatDateTime(session.created_at)}`}
              >
                <div className="flex items-center gap-1.5">
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editing.value}
                      onChange={(e) => setEditing({ id: session.id, value: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => {
                        void renameSession(session.id, editing.value);
                        setEditing(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void renameSession(session.id, editing.value);
                          setEditing(null);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setEditing(null);
                        }
                      }}
                      className="flex-1 min-w-0 px-1 py-0.5 rounded bg-primary text-[12px] text-text-primary outline-none ring-1 ring-accent/60"
                    />
                  ) : (
                    <span className="flex-1 min-w-0 truncate text-[12px] text-text-primary font-medium">
                      {session.title}
                    </span>
                  )}
                  <span className="text-[10px] text-text-muted/85 tabular-nums shrink-0">
                    {formatConversationTime(session.updated_at)}
                  </span>
                </div>
                <div className="flex items-center gap-1 mt-0.5">
                  <span className="flex-1 min-w-0 truncate text-[10px] text-text-muted/85">
                    {session.last_message || "暂无消息"}
                  </span>
                  {session.message_count > 0 && (
                    <span className="shrink-0 min-w-4 h-4 px-1 rounded-full bg-accent/15 text-accent text-[9px] flex items-center justify-center tabular-nums">
                      {session.message_count}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "重命名",
              icon: <PencilLine size={14} />,
              onClick: () => setEditing({ id: menu.session.id, value: menu.session.title }),
            },
            {
              label: "复制整个会话",
              icon: <Search size={14} className="opacity-0" />,
              onClick: () => void copyConversation(menu.session),
            },
            { separator: true, label: "", onClick: () => {} },
            {
              label: "删除会话",
              icon: <Trash2 size={14} />,
              danger: true,
              onClick: () => void deleteSession(menu.session.id),
            },
          ]}
        />
      )}
    </div>
  );
}
