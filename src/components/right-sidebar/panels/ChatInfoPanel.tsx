/**
 * ChatInfoPanel - 会话信息面板（右侧边栏，会话视图下替代文件信息）
 *
 * 展示当前会话的时间口径与消息构成；附件列表可直接在编辑器打开或在资源管理器中定位。
 */
import { ExternalLink, FileText, Image as ImageIcon, MessageSquare } from "lucide-react";
import { useEditorStore } from "@/store/editor";
import { formatChatDateTime } from "@/utils/chatTime";
import { chatDisplayName, formatChatSize, isImageFileName } from "@/components/chat/chatFormat";
import { openChatFile, revealChatFile } from "@/components/chat/chatOpen";

export default function ChatInfoPanel() {
  const sessions = useEditorStore((s) => s.chatSessions);
  const activeSessionId = useEditorStore((s) => s.chatActiveSessionId);
  const messages = useEditorStore((s) => s.chatMessages);
  const showNotification = useEditorStore((s) => s.showNotification);

  const session = sessions.find((s) => s.id === activeSessionId) ?? null;

  if (!session) {
    return <div className="p-4 text-xs text-text-muted italic">未选择会话</div>;
  }

  const attachments = messages.filter((message) => !!message.file_path);
  const counts = {
    text: messages.filter((m) => m.kind === "text").length,
    image: messages.filter((m) => m.kind === "image").length,
    file: messages.filter((m) => m.kind === "file").length,
  };
  const attachmentBytes = attachments.reduce((sum, m) => sum + (m.file_size || 0), 0);
  const editedCount = messages.filter((m) => m.edited).length;

  return (
    <div className="p-4 space-y-5">
      <div className="space-y-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted/85">
          会话信息
        </h3>
        <div className="space-y-1.5">
          <div className="flex justify-between gap-2">
            <span className="text-xs text-text-muted shrink-0">标题</span>
            <span className="text-xs text-text-secondary truncate" title={session.title}>
              {session.title}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-xs text-text-muted shrink-0">创建时间</span>
            <span className="text-xs text-text-secondary tabular-nums">
              {formatChatDateTime(session.created_at)}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-xs text-text-muted shrink-0">最近编辑</span>
            <span className="text-xs text-text-secondary tabular-nums">
              {formatChatDateTime(session.updated_at)}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-xs text-text-muted shrink-0">消息条数</span>
            <span className="text-xs text-text-secondary tabular-nums">{messages.length}</span>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted/85">
          消息构成
        </h3>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              <MessageSquare size={11} />
              文字
            </span>
            <span className="text-xs text-text-secondary tabular-nums">{counts.text}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              <ImageIcon size={11} />
              图片
            </span>
            <span className="text-xs text-text-secondary tabular-nums">{counts.image}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs text-text-muted">
              <FileText size={11} />
              文件
            </span>
            <span className="text-xs text-text-secondary tabular-nums">{counts.file}</span>
          </div>
          {editedCount > 0 && (
            <div className="flex justify-between gap-2">
              <span className="text-xs text-text-muted">已编辑</span>
              <span className="text-xs text-text-secondary tabular-nums">{editedCount}</span>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted/85">
          附件 {attachments.length > 0 && `(${attachments.length} · ${formatChatSize(attachmentBytes)})`}
        </h3>
        {attachments.length === 0 ? (
          <p className="text-xs text-text-muted italic">暂无附件</p>
        ) : (
          <div className="space-y-0.5">
            {[...attachments].reverse().map((message) => (
              <div
                key={message.id}
                className="group/att flex items-center gap-1.5 px-1.5 py-1 rounded-lg hover:bg-surface/50 transition-colors"
                title={message.file_path ?? undefined}
              >
                {isImageFileName(message.file_name) ? (
                  <ImageIcon size={12} className="text-accent shrink-0" />
                ) : (
                  <FileText size={12} className="text-text-muted shrink-0" />
                )}
                <button
                  onClick={() => void openChatFile(message.file_path!, showNotification)}
                  className="flex-1 min-w-0 text-left cursor-pointer"
                >
                  <span className="block truncate text-[11px] text-text-secondary">
                    {chatDisplayName(message.file_name)}
                  </span>
                  <span className="block text-[9px] text-text-muted/85 tabular-nums">
                    {formatChatSize(message.file_size)} · {formatChatDateTime(message.created_at)}
                  </span>
                </button>
                <button
                  onClick={() => revealChatFile(message.file_path!, showNotification)}
                  title="在资源管理器中显示"
                  className="p-1 rounded text-text-muted opacity-0 group-hover/att:opacity-100 hover:text-accent hover:bg-surface transition-all cursor-pointer shrink-0"
                >
                  <ExternalLink size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
