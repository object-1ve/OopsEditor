/**
 * 会话输入区：文字发送、选择文件、选择图片、剪贴板粘贴图片、拖放附件。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Paperclip, SendHorizontal, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { storeChatBase64, storeChatFile, type ChatAttachment } from "@/services/chat";
import { chatDisplayName, formatChatSize, isImageFileName } from "./chatFormat";
import { registerChatDropZone, subscribeChatDragOver } from "./dropTarget";

interface ChatComposerProps {
  /** 是否禁用（未选中会话时不能发送） */
  disabled: boolean;
  isSending: boolean;
  onSendText: (text: string) => Promise<void>;
  onSendAttachment: (attachment: ChatAttachment, kind: "file" | "image", caption: string) => Promise<void>;
  onError: (message: string) => void;
}

const IMAGE_FILTER = {
  name: "图片",
  extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "avif"],
};

export default function ChatComposer({
  disabled,
  isSending,
  onSendText,
  onSendAttachment,
  onError,
}: ChatComposerProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<{ attachment: ChatAttachment; kind: "file" | "image" }[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  /** 文件只入库一次：先落盘拿到哈希路径，再随消息一起提交 */
  const ingestPaths = useCallback(
    async (paths: string[]) => {
      const added: { attachment: ChatAttachment; kind: "file" | "image" }[] = [];
      for (const path of paths) {
        try {
          const attachment = await storeChatFile(path);
          const name = attachment.name || path.split(/[/\\]/).pop() || path;
          added.push({ attachment, kind: isImageFileName(name) ? "image" : "file" });
        } catch (err) {
          onError(`添加附件失败: ${String(err)}`);
        }
      }
      if (added.length > 0) setPending((prev) => [...prev, ...added]);
    },
    [onError],
  );

  // OS 拖放落在输入区时，由 App 判定落点后回调这里
  useEffect(() => {
    registerChatDropZone(dropZoneRef.current, (paths) => void ingestPaths(paths));
    return () => registerChatDropZone(null, null);
  }, [ingestPaths]);

  useEffect(() => subscribeChatDragOver(setIsDragOver), []);

  // 剪贴板图片：直接落盘为附件，和拖图片进输入区等价
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (disabled) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        event.preventDefault();
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const base64 = String(reader.result).split(",")[1] ?? "";
            const attachment = await storeChatBase64(base64, file.name || "clipboard.png");
            setPending((prev) => [...prev, { attachment, kind: "image" }]);
          } catch (err) {
            onError(`添加剪贴板图片失败: ${String(err)}`);
          }
        };
        reader.onerror = () => onError("读取剪贴板图片失败");
        reader.readAsDataURL(file);
        return;
      }
    };
    document.addEventListener("paste", handlePaste, true);
    return () => document.removeEventListener("paste", handlePaste, true);
  }, [disabled, onError]);

  const handlePickFiles = useCallback(async () => {
    try {
      const selected = await open({ multiple: true, title: "选择要发送的文件" });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      await ingestPaths(paths);
    } catch (err) {
      onError(`选择文件失败: ${String(err)}`);
    }
  }, [ingestPaths, onError]);

  const handlePickImages = useCallback(async () => {
    try {
      const selected = await open({ multiple: true, filters: [IMAGE_FILTER], title: "选择要发送的图片" });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      await ingestPaths(paths);
    } catch (err) {
      onError(`选择图片失败: ${String(err)}`);
    }
  }, [ingestPaths, onError]);

  const send = useCallback(async () => {
    if (disabled || isSending) return;
    const caption = text.trim();
    if (pending.length === 0 && !caption) return;

    try {
      if (pending.length > 0) {
        for (let i = 0; i < pending.length; i += 1) {
          // 说明文字附在最后一条附件消息上，符合聊天软件习惯
          const isLast = i === pending.length - 1;
          await onSendAttachment(pending[i].attachment, pending[i].kind, isLast ? caption : "");
        }
      } else {
        await onSendText(caption);
      }
      setText("");
      setPending([]);
    } catch (err) {
      onError(`发送失败: ${String(err)}`);
    }
  }, [disabled, isSending, onError, onSendAttachment, onSendText, pending, text]);

  const hasDraft = pending.length > 0 || text.trim().length > 0;

  return (
    <div className="border-t border-border shrink-0 bg-deepest">
      {/* 待发送附件预览 */}
      {pending.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
          {pending.map((item, index) => (
            <div
              key={`${item.attachment.path}-${index}`}
              className="group/att relative flex items-center gap-1.5 pl-1.5 pr-5 py-1 rounded-lg bg-surface border border-border max-w-full"
            >
              {item.kind === "image" ? (
                <img
                  src={convertFileSrc(item.attachment.path)}
                  alt={item.attachment.name}
                  className="w-6 h-6 rounded object-cover shrink-0 bg-black/5"
                />
              ) : (
                <span className="w-6 h-6 rounded bg-black/5 flex items-center justify-center shrink-0">
                  <Paperclip size={11} className="text-text-muted" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block text-[11px] text-text-secondary truncate max-w-32">
                  {chatDisplayName(item.attachment.name)}
                </span>
                <span className="block text-[9px] text-text-muted/85">{formatChatSize(item.attachment.size)}</span>
              </span>
              <button
                onClick={() => setPending((prev) => prev.filter((_, i) => i !== index))}
                title="移除附件"
                className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-muted hover:text-error hover:bg-error/10 transition-colors cursor-pointer"
              >
                <X size={10} />
              </button>
            </div>
          ))}
          {pending.length > 1 && (
            <button
              onClick={() => setPending([])}
              className="self-center px-2 py-1 text-[10px] text-text-muted hover:text-error transition-colors cursor-pointer"
            >
              清空附件
            </button>
          )}
        </div>
      )}

      <div ref={dropZoneRef} className="p-2">
        <div
          className={`rounded-xl border transition-colors ${
            isDragOver ? "border-accent bg-accent/5" : "border-border bg-primary"
          }`}
        >
          <textarea
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // isComposing：中文输入法选词时的回车不能当成发送
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={
              disabled
                ? "先选择一个会话"
                : isDragOver
                  ? "释放以添加为附件"
                  : "输入消息，Enter 发送 / Shift+Enter 换行；可直接粘贴或拖入文件"
            }
            className="w-full resize-none bg-transparent px-3 pt-2 text-[12px] text-text-primary placeholder:text-text-muted/85 outline-none disabled:cursor-not-allowed"
          />

          <div className="flex items-center justify-between px-2 pb-1.5">
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => void handlePickFiles()}
                disabled={disabled}
                title="发送文件"
                className="p-1.5 rounded-lg text-text-muted hover:text-accent hover:bg-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                <Paperclip size={14} />
              </button>
              <button
                onClick={() => void handlePickImages()}
                disabled={disabled}
                title="发送图片"
                className="p-1.5 rounded-lg text-text-muted hover:text-accent hover:bg-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                <ImagePlus size={14} />
              </button>
            </div>

            <button
              onClick={() => void send()}
              disabled={disabled || !hasDraft || isSending}
              title="发送 (Enter)"
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors ${
                disabled || !hasDraft || isSending
                  ? "bg-surface text-text-muted cursor-not-allowed"
                  : "bg-accent text-white hover:bg-accent-bright cursor-pointer"
              }`}
            >
              <SendHorizontal size={12} />
              {isSending ? "发送中" : "发送"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
