import { useEffect, useRef } from "react";
import { Settings, X, FolderOpen } from "lucide-react";
import { useEditorStore } from "@/store/editor";
import {
  MAX_OPEN_TABS_LIMIT,
  MIN_OPEN_TABS_LIMIT,
} from "@/utils/settings";
import { open } from "@tauri-apps/plugin-dialog";

export default function SettingsModal() {
  const {
    isSettingsOpen,
    closeSettings,
    editorWordWrap,
    setEditorWordWrap,
    autoSaveOnEdit,
    setAutoSaveOnEdit,
    maxOpenTabs,
    setMaxOpenTabs,
    defaultSavePath,
    setDefaultSavePath,
    maxRecentFolders,
    setMaxRecentFolders,
  } = useEditorStore();
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeSettings();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [closeSettings, isSettingsOpen]);

  if (!isSettingsOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
        onClick={closeSettings}
      />

      <div
        ref={modalRef}
        className="relative w-full max-w-md overflow-hidden rounded-xl border border-border bg-secondary shadow-2xl animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between border-b border-border bg-surface/50 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Settings size={18} className="text-accent" />
            <h3 className="text-sm font-bold tracking-tight uppercase text-text">
              设置
            </h3>
          </div>
          <button
            onClick={closeSettings}
            className="rounded-md p-1 transition-colors hover:bg-surface hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5 max-h-[60vh] overflow-y-auto">
          <div className="rounded-xl border border-border bg-primary/40 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="text-sm font-medium text-text">自动换行</div>
                <p className="text-xs leading-relaxed text-text-secondary">
                  开启后，文本编辑器会自动换行显示长内容。
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={editorWordWrap}
                onClick={() => setEditorWordWrap(!editorWordWrap)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  editorWordWrap ? "bg-accent" : "bg-surface"
                }`}
                title={editorWordWrap ? "关闭自动换行" : "开启自动换行"}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    editorWordWrap ? "translate-x-5" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-primary/40 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="text-sm font-medium text-text">自动保存</div>
                <p className="text-xs leading-relaxed text-text-secondary">
                  开启后，编辑文件 1 秒无操作会自动保存到磁盘，无需手动 Ctrl+S。
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoSaveOnEdit}
                onClick={() => setAutoSaveOnEdit(!autoSaveOnEdit)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  autoSaveOnEdit ? "bg-accent" : "bg-surface"
                }`}
                title={autoSaveOnEdit ? "关闭自动保存" : "开启自动保存"}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                    autoSaveOnEdit ? "translate-x-5" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-primary/40 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="text-sm font-medium text-text">标签页上限</div>
                <p className="text-xs leading-relaxed text-text-secondary">
                  最多保留 {maxOpenTabs} 个标签。超过后会自动关闭最早打开且未修改的标签，已修改标签会保留。
                </p>
              </div>
              <input
                type="number"
                min={MIN_OPEN_TABS_LIMIT}
                max={MAX_OPEN_TABS_LIMIT}
                step={1}
                value={maxOpenTabs}
                onChange={(event) => {
                  const nextValue = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(nextValue)) {
                    setMaxOpenTabs(nextValue);
                  }
                }}
                className="w-20 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text outline-none transition-colors focus:border-accent"
                title={`设置最大标签页数量（${MIN_OPEN_TABS_LIMIT}-${MAX_OPEN_TABS_LIMIT}）`}
              />
            </div>
          </div>

          <div className="rounded-xl border border-border bg-primary/40 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1 flex-1 min-w-0">
                <div className="text-sm font-medium text-text">默认文件保存路径</div>
                <p className="text-xs leading-relaxed text-text-secondary">
                  双击标签栏空白区域创建新文件时的默认保存目录。
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const selected = await open({ directory: true, multiple: false });
                      if (selected && typeof selected === "string") {
                        setDefaultSavePath(selected);
                      }
                    } catch (err) {
                      console.error("Failed to select default save path:", err);
                    }
                  }}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface/80 hover:text-accent"
                  title="选择文件夹"
                >
                  <FolderOpen size={14} />
                  <span>浏览</span>
                </button>
              </div>
            </div>
            {defaultSavePath && (
              <div className="mt-2 rounded-md bg-deepest/60 px-3 py-2 text-xs font-mono text-accent/70 truncate">
                {defaultSavePath}
              </div>
            )}
            {!defaultSavePath && (
              <div className="mt-2 rounded-md bg-deepest/60 px-3 py-2 text-xs font-mono text-text-muted/50 italic">
                未设置，将使用默认文件夹路径
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-primary/40 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="text-sm font-medium text-text">最近文件夹保存条数</div>
                <p className="text-xs leading-relaxed text-text-secondary">
                  记录最近打开的文件夹数量，超过上限后自动清理最旧的记录。
                </p>
              </div>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={maxRecentFolders}
                onChange={(event) => {
                  const nextValue = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(nextValue)) {
                    setMaxRecentFolders(nextValue);
                  }
                }}
                className="w-20 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text outline-none transition-colors focus:border-accent"
                title="设置最近文件夹保存数量（1-100）"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end border-t border-border bg-surface/30 px-5 py-4">
          <button
            onClick={closeSettings}
            className="rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-accent-bright"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
