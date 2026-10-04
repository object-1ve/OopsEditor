/**
 * 单条会话消息气泡：文字 / 文件 / 图片三种形态，右侧自己、左侧对方。
 */
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Maximize2, PencilLine, Star, Trash2, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import ContextMenu from "@/components/ContextMenu";
import MaterialFileIcon from "@/components/MaterialFileIcon";
import type { ChatMessage } from "@/services/chat";
import { formatChatDateTime } from "@/utils/chatTime";
import { chatDisplayName, formatChatSize, isImageFileName } from "./chatFormat";

export interface ChatMessageActions {
  onEdit: (id: number, content: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** 收藏 / 取消收藏（favorited 是目标状态，不是取反） */
  onToggleFavorite: (id: number, favorited: boolean) => Promise<void>;
  onOpenFile: (path: string, displayName?: string | null) => void;
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
  // 编辑态锁住原气泡宽度：气泡本身是 shrink-to-fit，编辑时内容换成 textarea 会塌成按钮行宽度
  const [editWidth, setEditWidth] = useState<number | null>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isMine = message.role === "me";
  const favorited = message.favorited;
  const hasFile = !!message.file_path;
  const isImage = message.kind === "image" || isImageFileName(message.file_name);
  // 图片副本名带内容哈希（存储去重用），展示时摘掉；文件消息本身就是原始名
  const displayName = isImage ? chatDisplayName(message.file_name) : message.file_name ?? "附件";

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

  /** 进入编辑：先量当前气泡宽度并按此宽度进入编辑态，避免气泡跳成固定窄条 */
  const startEdit = useCallback(() => {
    const el = bubbleRef.current;
    // 最窄 13rem：纯文字极短的消息（如「ok」）原宽放不下输入框与按钮
    if (el) setEditWidth(Math.max(el.getBoundingClientRect().width, 208));
    setDraft(message.content);
    setIsEditing(true);
  }, [message.content]);

  // 高度不设上限：宽度已锁定，textarea 的换行与原文一致，按内容整段撑开（不做 6 行滚动）
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!isEditing || !ta) return;
    ta.style.height = "auto";
    // 加回边框高度，避免 border-box 下差 2px 出滚动条
    ta.style.height = `${ta.scrollHeight + (ta.offsetHeight - ta.clientHeight)}px`;
  }, [isEditing, draft]);

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
          ref={bubbleRef}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
          style={isEditing && editWidth ? { width: editWidth, maxWidth: "100%" } : undefined}
          className={`chat-bubble relative rounded-2xl px-3 py-2 text-[12px] leading-relaxed wrap-anywhere whitespace-pre-wrap shadow-sm text-text-primary ${
            isEditing
              ? "border border-accent ring-2 ring-accent/30 bg-white"
              : favorited
                ? "border border-accent-warm ring-2 ring-accent-warm/35 bg-accent-warm/15"
                : `border bg-white ${isMine ? "border-accent/45" : "border-border"}`
          } ${isMine ? "rounded-br-md" : "rounded-bl-md"}`}
        >
          {isEditing ? (
            <div className="flex flex-col gap-1.5">
              {/* 编辑只改文字说明，附件保留；这里把附件原样带出来，避免"编辑后图片不见了"的错觉 */}
              {hasFile && isImage && (
                <img
                  src={convertFileSrc(message.file_path!)}
                  alt={message.file_name ?? "图片"}
                  onClick={() => actions.onPreviewImage(message.file_path!, message.file_name)}
                  title="点击放大查看"
                  className="self-start max-h-56 w-auto max-w-full rounded-lg cursor-zoom-in object-contain bg-black/5 transition-opacity hover:opacity-90"
                />
              )}

              {hasFile && !isImage && (
                <div
                  className="flex items-center gap-2 min-w-0"
                  title={`此附件保持不变\n${message.file_path}`}
                >
                  <span className="w-7 h-7 shrink-0 rounded-lg bg-black/10 flex items-center justify-center">
                    <MaterialFileIcon name={displayName} size={16} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{displayName}</span>
                    <span className="block text-[10px] text-text-muted">
                      {formatChatSize(message.file_size)}
                    </span>
                  </span>
                </div>
              )}

              <textarea
                ref={textareaRef}
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
                placeholder={hasFile ? "输入附件说明…" : "输入消息内容…"}
                className="w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-[12px] leading-relaxed wrap-anywhere text-text-primary placeholder:text-text-muted/70"
                style={{ outline: "none" }}
                rows={2}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[10px] text-text-muted/85">
                  {hasFile ? (isImage ? "编辑仅修改文字说明，图片不变" : "编辑仅修改附件说明，文件不变") : ""}
                </span>
                <div className="flex items-center gap-1 shrink-0">
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
                  onClick={() => actions.onOpenFile(message.file_path!, displayName)}
                  className="flex items-center gap-2 w-full text-left cursor-pointer group/file"
                  title={`在编辑器中打开原文件\n${message.file_path}`}
                >
                  <span className="w-8 h-8 shrink-0 rounded-lg bg-black/10 flex items-center justify-center">
                    <MaterialFileIcon name={displayName} size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{displayName}</span>
                    <span className="block text-[10px] text-text-muted">
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
              <BubbleAction title={hasFile ? "编辑说明" : "编辑"} onClick={startEdit}>
                <PencilLine size={11} />
              </BubbleAction>
            )}
            <BubbleAction title={isCopied ? "已复制" : "复制文字"} onClick={() => void copyText()}>
              {isCopied ? <Check size={11} /> : <Copy size={11} />}
            </BubbleAction>
            {hasFile && !isImage && (
              <BubbleAction title="在编辑器中打开原文件" onClick={() => actions.onOpenFile(message.file_path!, displayName)}>
                <ExternalLink size={11} />
              </BubbleAction>
            )}
            {hasFile && (
              <BubbleAction title="在资源管理器中显示" onClick={() => actions.onRevealFile(message.file_path!)}>
                <ExternalLink size={11} />
              </BubbleAction>
            )}
            <BubbleAction title="删除消息" onClick={() => void actions.onDelete(message.id)} danger>
              <Trash2 size={11} />
            </BubbleAction>
          </div>
          {/* 收藏星标：已收藏时常显（不随 hover 隐藏），未收藏时与操作按钮同样只在 hover 时出现 */}
          <button
            onClick={() => void actions.onToggleFavorite(message.id, !favorited)}
            title={favorited ? "取消收藏" : "收藏"}
            aria-pressed={favorited}
            className={`p-0.5 rounded transition-colors cursor-pointer ${
              favorited
                ? "text-accent-warm hover:bg-accent-warm/15"
                : "opacity-0 group-hover/msg:opacity-100 text-text-muted/85 hover:text-accent-warm hover:bg-black/5"
            }`}
          >
            <Star size={11} className={favorited ? "fill-accent-warm" : ""} />
          </button>
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
              onClick: startEdit,
            },
            { label: "复制文字", icon: <Copy size={14} />, onClick: () => void copyText() },
            {
              label: favorited ? "取消收藏" : "收藏",
              icon: <Star size={14} className={favorited ? "fill-accent-warm text-accent-warm" : ""} />,
              onClick: () => void actions.onToggleFavorite(message.id, !favorited),
            },
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
                    onClick: () => actions.onOpenFile(message.file_path!, displayName),
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
