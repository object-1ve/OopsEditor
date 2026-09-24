/**
 * 单条会话消息气泡：文字 / 文件 / 图片三种形态，右侧自己、左侧对方。
 */
import { useCallback, useState } from "react";
import { Check, Copy, Download, ExternalLink, Maximize2, PencilLine, Trash2, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import ContextMenu from "@/components/ContextMenu";
import type { ChatMessage } from "@/services/chat";
import { formatChatDateTime } from "@/utils/chatTime";
import { chatDisplayName, formatChatSize, isImageFileName } from "./chatFormat";

export interface ChatMessageActions {
  onEdit: (id: number, content: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onOpenFile: (path: string) => void;
  onRevealFile: (path: string) => void;
  /** 图片附件的全屏放大查看 */
  onPreviewImage: (path: string, name?: string | null) => void;
}

interface MessageBubbleProps {
  message: ChatMessage;
  actions: ChatMessageActions;
}

/** 气泡上可点的操作按钮，hover 时才显示 */
function BubbleAction({
  title,
  onClick,
  children,
  danger = false,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1 rounded transition-colors cursor-pointer ${
        danger ? "text-text-muted hover:text-error hover:bg-error/10" : "text-text-muted hover:text-accent hover:bg-surface"
      }`}
    >
      {children}
    </button>
  );
}

export default function MessageBubble({ message, actions }: MessageBubbleProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [isCopied, setIsCopied] = useState(false);

  const isMine = message.role === "me";
  const hasFile = !!message.file_path;
  const isImage = message.kind === "image" || isImageFileName(message.file_name);

  const copyText = useCallback(async () => {
    // 文件消息没有正文时复制文件名，比复制空串更有用
    const text = message.content || message.file_name || "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1200);
    } catch {
      // 剪贴板不可用时静默失败，用户可改用右键菜单
    }
  }, [message.content, message.file_name]);

  const saveEdit = useCallback(async () => {
    const next = draft.trim();
    if (!next && !hasFile) return;
    await actions.onEdit(message.id, next);
    setIsEditing(false);
  }, [actions, draft, hasFile, message.id]);

  return (
    <div className={`group/msg flex gap-2 px-2 ${isMine ? "flex-row-reverse" : "flex-row"}`}>
      {/* 头像：自己/对方用不同色调区分 */}
      <div
        className={`mt-0.5 w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-[10px] font-medium select-none ${
          isMine ? "bg-accent/20 text-accent" : "bg-secondary text-text-secondary"
        }`}
      >
        {isMine ? "我" : "他"}
      </div>

      <div className={`flex flex-col min-w-0 max-w-[85%] ${isMine ? "items-end" : "items-start"}`}>
        {/* 气泡本体 */}
        <div
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
          className={`relative rounded-2xl px-3 py-2 text-[12px] leading-relaxed break-words whitespace-pre-wrap shadow-sm ${
            isMine
              ? "bg-accent text-white rounded-br-md"
              : "bg-surface text-text-primary rounded-bl-md border border-border"
          }`}
        >
          {isEditing ? (
            <div className="flex flex-col gap-1.5 min-w-40">
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setDraft(message.content);
                    setIsEditing(false);
                  } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void saveEdit();
                  }
                }}
                className="w-full resize-none rounded-lg bg-white/90 px-2 py-1 text-[12px] text-text-primary outline-none focus:ring-1 focus:ring-accent/60"
                rows={Math.min(6, Math.max(2, draft.split("\n").length))}
              />
              <div className="flex items-center justify-end gap-1">
                <button
                  onClick={() => {
                    setDraft(message.content);
                    setIsEditing(false);
                  }}
                  className="px-2 py-0.5 rounded text-[11px] bg-black/10 hover:bg-black/20 transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  onClick={() => void saveEdit()}
                  className="px-2 py-0.5 rounded text-[11px] bg-black/20 hover:bg-black/30 transition-colors cursor-pointer"
                >
                  保存
                </button>
              </div>
            </div>
          ) : (
            <>
              {hasFile && isImage && (
                <img
                  src={convertFileSrc(message.file_path!)}
                  alt={message.file_name ?? "图片"}
                  onClick={() => actions.onPreviewImage(message.file_path!, message.file_name)}
                  title="点击放大查看"
                  className="max-h-56 w-auto max-w-full rounded-lg cursor-zoom-in object-contain bg-black/5 transition-opacity hover:opacity-90"
                  loading="lazy"
                />
              )}

              {hasFile && !isImage && (
                <button
                  onClick={() => actions.onOpenFile(message.file_path!)}
                  className="flex items-center gap-2 w-full text-left cursor-pointer group/file"
                  title="在编辑器中打开"
                >
                  <span className="w-8 h-8 shrink-0 rounded-lg bg-black/10 flex items-center justify-center">
                    <Download size={14} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{chatDisplayName(message.file_name)}</span>
                    <span className={`block text-[10px] ${isMine ? "text-white/80" : "text-text-muted"}`}>
                      {formatChatSize(message.file_size)}
                    </span>
                  </span>
                </button>
              )}

              {message.content && (
                <span className={hasFile ? "block mt-1.5" : "block"}>{message.content}</span>
              )}
            </>
          )}
        </div>

        {/* 时间 / 编辑标记 / 操作 */}
        <div className={`flex items-center gap-1 mt-0.5 px-1 ${isMine ? "flex-row-reverse" : "flex-row"}`}>
          <span className="text-[10px] text-text-muted/85 tabular-nums" title={formatChatDateTime(message.created_at)}>
            {formatChatDateTime(message.created_at).slice(-5)}
          </span>
          {message.edited && <span className="text-[10px] text-text-muted/85">已编辑</span>}
          <div
            className={`flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity ${
              isMine ? "flex-row-reverse" : "flex-row"
            }`}
          >
            {!isEditing && (
              <BubbleAction title={hasFile ? "编辑说明" : "编辑"} onClick={() => setIsEditing(true)}>
                <PencilLine size={11} />
              </BubbleAction>
            )}
            <BubbleAction title={isCopied ? "已复制" : "复制文字"} onClick={() => void copyText()}>
              {isCopied ? <Check size={11} /> : <Copy size={11} />}
            </BubbleAction>
            {hasFile && (
              <BubbleAction title="在资源管理器中显示" onClick={() => actions.onRevealFile(message.file_path!)}>
                <ExternalLink size={11} />
              </BubbleAction>
            )}
            <BubbleAction title="删除消息" onClick={() => void actions.onDelete(message.id)} danger>
              <Trash2 size={11} />
            </BubbleAction>
          </div>
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: hasFile ? "编辑说明" : "编辑",
              icon: <PencilLine size={14} />,
              onClick: () => setIsEditing(true),
            },
            { label: "复制文字", icon: <Copy size={14} />, onClick: () => void copyText() },
            ...(hasFile && isImage
              ? [
                  {
                    label: "放大查看",
                    icon: <Maximize2 size={14} />,
                    onClick: () => actions.onPreviewImage(message.file_path!, message.file_name),
                  },
                  { separator: true, label: "", onClick: () => {} },
                ]
              : []),
            ...(hasFile
              ? [
                  {
                    label: "在编辑器中打开",
                    icon: <ExternalLink size={14} />,
                    onClick: () => actions.onOpenFile(message.file_path!),
                  },
                  {
                    label: "在资源管理器中显示",
                    icon: <ExternalLink size={14} />,
                    onClick: () => actions.onRevealFile(message.file_path!),
                  },
                  { separator: true, label: "", onClick: () => {} },
                ]
              : []),
            {
              label: "删除消息",
              icon: hasFile ? <X size={14} /> : <Trash2 size={14} />,
              danger: true,
              onClick: () => void actions.onDelete(message.id),
            },
          ]}
        />
      )}
    </div>
  );
}
