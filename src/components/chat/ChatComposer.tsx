/**
 * 会话输入区：文字发送、选择文件、选择图片、剪贴板粘贴图片、拖放附件。
 *
 * 发送语义：
 * - 文件只把**本地路径**记进消息（后端仅做一次 stat 校验），发送瞬时完成、原文件更新即刻可见；
 * - 图片会缓存一份副本，因为缩略图要走 asset 协议渲染，需要稳定路径。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, ImagePlus, Paperclip, SendHorizontal, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { isImagePath } from "@/services/chat";
import { chatDisplayName } from "./chatFormat";
import { registerChatDropZone, subscribeChatDragOver } from "./dropTarget";

interface ChatComposerProps {
  /** 是否禁用（未选中会话时不能发送） */
  disabled: boolean;
  isSending: boolean;
  onSendText: (text: string) => Promise<void>;
  onSendFiles: (paths: string[], caption: string) => Promise<void>;
  onSendImages: (paths: string[], caption: string) => Promise<void>;
  onSendClipboardImage: (base64: string, name: string, caption: string) => Promise<void>;
  onError: (message: string) => void;
}

const IMAGE_FILTER = {
  name: "图片",
  extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "avif"],
};

/** 待发送项：文件只存路径，图片额外存 asset URL 用于缩略图 */
interface PendingItem {
  path: string;
  name: string;
  size: number;
  isImage: boolean;
}

export default function ChatComposer({
  disabled,
  isSending,
  onSendText,
  onSendFiles,
  onSendImages,
  onSendClipboardImage,
  onError,
}: ChatComposerProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [pastedImages, setPastedImages] = useState<Record<string, { base64: string; name: string }>>({});
  const [isDragOver, setIsDragOver] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  /**
   * 加入待发送列表：只登记路径，不再预读/复制文件。
   * 大小按需从后端取，避免为了显示体积而读整个文件。
   */
  const ingestPaths = useCallback(
    async (paths: string[]) => {
      const added: PendingItem[] = [];
      for (const path of paths) {
        const name = path.split(/[/\\]/).pop() || path;
        let size = 0;
        try {
          const info = await invoke<{ size: number }>("get_file_info", { path });
          size = info.size;
        } catch {
          onError(`无法访问文件: ${name}`);
          continue;
        }
        added.push({ path, name, size, isImage: isImagePath(path) });
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

  // 剪贴板图片：浏览器里拿不到路径，先留在内存，发送时再交给后端落盘
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
        reader.onload = () => {
          const base64 = String(reader.result).split(",")[1] ?? "";
          const name = file.name || "clipboard.png";
          // 用内存中的 data URL 直接预览，无需先落盘
          setPastedImages((prev) => ({ ...prev, [name]: { base64, name } }));
          setPending((prev) => [
            ...prev,
            { path: name, name, size: file.size, isImage: true },
          ]);
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
        const filePaths = pending.filter((item) => !item.isImage).map((item) => item.path);
        const imagePaths = pending.filter((item) => item.isImage && !pastedImages[item.path]).map((item) => item.path);

        // 说明文字附在最后发出的那条消息上，符合聊天软件习惯
        if (filePaths.length > 0) await onSendFiles(filePaths, imagePaths.length === 0 ? caption : "");
        for (let i = 0; i < imagePaths.length; i += 1) {
          const isLastImage = i === imagePaths.length - 1;
          await onSendImages([imagePaths[i]], isLastImage ? caption : "");
        }
        for (const item of pending) {
          const pasted = pastedImages[item.path];
          if (!pasted) continue;
          const isLast = item === pending[pending.length - 1];
          await onSendClipboardImage(pasted.base64, pasted.name, isLast ? caption : "");
        }
      } else {
        await onSendText(caption);
      }
      setText("");
      setPending([]);
      setPastedImages({});
    } catch (err) {
      onError(`发送失败: ${String(err)}`);
    }
  }, [disabled, isSending, onError, onSendClipboardImage, onSendFiles, onSendImages, onSendText, pastedImages, pending, text]);

  const hasDraft = pending.length > 0 || text.trim().length > 0;

  return (
    <div className="border-t border-border shrink-0 bg-deepest">
      {/* 待发送附件预览 */}
      {pending.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
          {pending.map((item, index) => {
            const pasted = pastedImages[item.path];
            return (
              <div
                key={`${item.path}-${index}`}
                className="group/att relative flex items-center gap-1.5 pl-1.5 pr-5 py-1 rounded-lg bg-surface border border-border max-w-full"
              >
                {item.isImage ? (
                  <img
                    src={pasted ? `data:image/png;base64,${pasted.base64}` : convertFileSrc(item.path)}
                    alt={item.name}
                    className="w-6 h-6 rounded object-cover shrink-0 bg-black/5"
                  />
                ) : (
                  <span className="w-6 h-6 rounded bg-black/5 flex items-center justify-center shrink-0">
                    <FileText size={11} className="text-text-muted" />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block text-[11px] text-text-secondary truncate max-w-32">
                    {item.name}
                  </span>
                  <span className="block text-[9px] text-text-muted/85">
                    {formatSize(item.size)}
                  </span>
                </span>
                <button
                  onClick={() => setPending((prev) => prev.filter((_, i) => i !== index))}
                  title="移除附件"
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-text-muted hover:text-error hover:bg-error/10 transition-colors cursor-pointer"
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}
          {pending.length > 1 && (
            <button
              onClick={() => {
                setPending([]);
                setPastedImages({});
              }}
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
                title="发送文件（仅记录路径）"
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

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "未知大小";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
