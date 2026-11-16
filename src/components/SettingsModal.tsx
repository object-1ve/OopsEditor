import { useEffect, useRef, useState, useCallback } from "react";
import type { ReactNode } from "react";
import {
  Settings,
  X,
  FolderOpen,
  Type,
  SlidersHorizontal,
  Palette,
  FolderClosed,
  ShieldCheck,
  Download,
} from "lucide-react";
import { useEditorStore } from "@/store/editor";
import {
  MAX_OPEN_TABS_LIMIT,
  MAX_RECENT_FILES_LIMIT,
  MIN_OPEN_TABS_LIMIT,
  MIN_RECENT_FILES_LIMIT,
} from "@/utils/settings";
import { FONT_FILE_FILTER } from "@/services/customFont";
import { open } from "@tauri-apps/plugin-dialog";
import { checkForUpdates, useUpdaterDialog } from "@/hooks/useUpdater";
import { version as APP_VERSION } from "../../package.json";

const SETTINGS_TABS = [
  { id: "editor", label: "编辑器", icon: SlidersHorizontal },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "files", label: "文件与记录", icon: FolderClosed },
  { id: "privacy", label: "隐私", icon: ShieldCheck },
  { id: "update", label: "更新", icon: Download },
] as const;

type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

/** 设置卡片：标题 + 说明 + 右侧操作，额外内容放 children（卡片下方） */
function SettingsCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-primary/40 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-sm font-medium text-text">{title}</div>
          <p className="text-xs leading-relaxed text-text-secondary">{description}</p>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

/** 开关按钮：三个设置项共用同一套外观与 aria 语义 */
function ToggleSwitch({
  checked,
  onChange,
  titleOn,
  titleOff,
}: {
  checked: boolean;
  onChange: () => void;
  titleOn: string;
  titleOff: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-surface"
      }`}
      title={checked ? titleOn : titleOff}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-1"
        }`}
      />
    </button>
  );
}

export default function SettingsModal() {
  const {
    isSettingsOpen,
    closeSettings,
    editorWordWrap,
    setEditorWordWrap,
    autoSaveOnEdit,
    setAutoSaveOnEdit,
    captureProtection,
    setCaptureProtection,
    maxOpenTabs,
    setMaxOpenTabs,
    defaultSavePath,
    setDefaultSavePath,
    maxRecentFolders,
    setMaxRecentFolders,
    maxRecentFiles,
    setMaxRecentFiles,
    customFontPath,
    customFontApplyToUi,
    setCustomFont,
    setCustomFontApplyToUi,
    updateProxy,
    setUpdateProxy,
  } = useEditorStore();
  const modalRef = useRef<HTMLDivElement>(null);
  const { checking } = useUpdaterDialog();
  const [isFontBusy, setIsFontBusy] = useState(false);
  // 代理输入草稿：失焦/回车才落库，避免每敲一个字符写一次 SQLite
  const [proxyDraft, setProxyDraft] = useState(updateProxy);
  /** 左侧分类：每次打开设置都回到第一项 */
  const [activeTab, setActiveTab] = useState<SettingsTabId>("editor");

  /** 选字体：只挑文件、不做任何读取，实际加载交给 setCustomFont */
  const handlePickFont = useCallback(async () => {
    try {
      const selected = await open({ multiple: false, filters: [FONT_FILE_FILTER] });
      if (!selected || typeof selected !== "string") return;
      setIsFontBusy(true);
      await setCustomFont(selected);
    } catch (err) {
      console.error("Failed to select font file:", err);
    } finally {
      setIsFontBusy(false);
    }
  }, [setCustomFont]);

  useEffect(() => {
    if (isSettingsOpen) {
      setProxyDraft(updateProxy);
      setActiveTab("editor");
    }
  }, [isSettingsOpen, updateProxy]);

  const commitProxy = useCallback(() => {
    if (proxyDraft.trim() !== updateProxy) {
      setUpdateProxy(proxyDraft);
    }
  }, [proxyDraft, setUpdateProxy, updateProxy]);

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
        className="relative flex h-[min(78vh,600px)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-secondary shadow-2xl animate-in zoom-in-95 duration-200"
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

        <div className="flex min-h-0 flex-1">
          {/* 左侧分类 */}
          <nav className="flex w-40 shrink-0 flex-col gap-1 border-r border-border bg-surface/20 p-2">
            {SETTINGS_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-medium transition-colors ${
                    isActive
                      ? "bg-surface text-text shadow-sm"
                      : "text-text-secondary hover:bg-surface/60 hover:text-text"
                  }`}
                >
                  <Icon
                    size={14}
                    className={isActive ? "text-accent" : "text-text-muted/85"}
                  />
                  <span className="truncate">{tab.label}</span>
                </button>
              );
            })}
          </nav>

          {/* 右侧内容 */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
            {activeTab === "editor" && (
              <>
                <SettingsCard
                  title="自动换行"
                  description="开启后，文本编辑器会自动换行显示长内容。"
                  action={
                    <ToggleSwitch
                      checked={editorWordWrap}
                      onChange={() => setEditorWordWrap(!editorWordWrap)}
                      titleOn="关闭自动换行"
                      titleOff="开启自动换行"
                    />
                  }
                />
                <SettingsCard
                  title="自动保存"
                  description="开启后，编辑文件 1 秒无操作会自动保存到磁盘，无需手动 Ctrl+S。"
                  action={
                    <ToggleSwitch
                      checked={autoSaveOnEdit}
                      onChange={() => setAutoSaveOnEdit(!autoSaveOnEdit)}
                      titleOn="关闭自动保存"
                      titleOff="开启自动保存"
                    />
                  }
                />
              </>
            )}

            {activeTab === "appearance" && (
              <SettingsCard
                title="自定义字体"
                description={
                  <>
                    支持 {FONT_FILE_FILTER.extensions.join(" / ")}。只记录字体文件路径，不复制文件；
                    默认只作用于编辑器与终端等代码区域。
                  </>
                }
                action={
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={handlePickFont}
                      disabled={isFontBusy}
                      className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface/80 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                      title="选择字体文件"
                    >
                      <Type size={14} />
                      <span>选择字体</span>
                    </button>
                    {customFontPath && (
                      <button
                        type="button"
                        onClick={() => void setCustomFont("")}
                        disabled={isFontBusy}
                        className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface/80 hover:text-error disabled:cursor-not-allowed disabled:opacity-50"
                        title="恢复内置字体"
                      >
                        恢复默认
                      </button>
                    )}
                  </div>
                }
              >
                <div className="space-y-3">
                  <div className="rounded-md bg-deepest/60 px-3 py-2 text-xs font-mono truncate">
                    {customFontPath ? (
                      <span className="text-accent/70">{customFontPath}</span>
                    ) : (
                      <span className="text-text-muted/80 italic">未设置，使用内置字体栈</span>
                    )}
                  </div>
                  {customFontPath && (
                    <div className="flex items-center gap-2">
                      <input
                        id="custom-font-apply-ui"
                        type="checkbox"
                        checked={customFontApplyToUi}
                        onChange={(event) => void setCustomFontApplyToUi(event.currentTarget.checked)}
                        className="h-3.5 w-3.5 cursor-pointer accent-[var(--accent)]"
                      />
                      <label
                        htmlFor="custom-font-apply-ui"
                        className="cursor-pointer select-none text-xs text-text-secondary"
                      >
                        同时应用到界面文字（关闭时仅编辑器 / 终端等代码区域）
                      </label>
                    </div>
                  )}
                </div>
              </SettingsCard>
            )}

            {activeTab === "files" && (
              <>
                <SettingsCard
                  title="标签页上限"
                  description={`最多保留 ${maxOpenTabs} 个标签。超过后会自动关闭最早打开且未修改的标签，已修改标签会保留。`}
                  action={
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
                  }
                />
                <SettingsCard
                  title="默认文件保存路径"
                  description="双击标签栏空白区域创建新文件时的默认保存目录。"
                  action={
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
                      className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface/80 hover:text-accent"
                      title="选择文件夹"
                    >
                      <FolderOpen size={14} />
                      <span>浏览</span>
                    </button>
                  }
                >
                  {defaultSavePath ? (
                    <div className="mt-3 truncate rounded-md bg-deepest/60 px-3 py-2 font-mono text-xs text-accent/70">
                      {defaultSavePath}
                    </div>
                  ) : (
                    <div className="mt-3 rounded-md bg-deepest/60 px-3 py-2 font-mono text-xs italic text-text-muted/80">
                      未设置，将使用默认文件夹路径
                    </div>
                  )}
                </SettingsCard>
                <SettingsCard
                  title="最近文件夹保存条数"
                  description="记录最近打开的文件夹数量，超过上限后自动清理最旧的记录。"
                  action={
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
                  }
                />
                <SettingsCard
                  title="最近文件记录条数"
                  description="记录最近打开的文件数量，超过上限后自动清理最旧的记录。"
                  action={
                    <input
                      type="number"
                      min={MIN_RECENT_FILES_LIMIT}
                      max={MAX_RECENT_FILES_LIMIT}
                      step={1}
                      value={maxRecentFiles}
                      onChange={(event) => {
                        const nextValue = event.currentTarget.valueAsNumber;
                        if (Number.isFinite(nextValue)) {
                          setMaxRecentFiles(nextValue);
                        }
                      }}
                      className="w-20 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text outline-none transition-colors focus:border-accent"
                      title={`设置最近文件记录数量（${MIN_RECENT_FILES_LIMIT}-${MAX_RECENT_FILES_LIMIT}）`}
                    />
                  }
                />
              </>
            )}

            {activeTab === "privacy" && (
              <SettingsCard
                title="防截图保护"
                description="开启后，屏幕截图/录屏无法捕获本应用窗口内容（系统级防护）。部分屏幕录制工具也会受影响。"
                action={
                  <ToggleSwitch
                    checked={captureProtection}
                    onChange={() => setCaptureProtection(!captureProtection)}
                    titleOn="关闭防截图保护"
                    titleOff="开启防截图保护"
                  />
                }
              />
            )}

            {activeTab === "update" && (
              <SettingsCard
                title="软件更新"
                description={`当前版本 v${APP_VERSION}，发现新版本时启动后会自动提示；下载中可以随时中断。`}
                action={
                  <button
                    type="button"
                    disabled={checking}
                    onClick={() => void checkForUpdates({ manual: true })}
                    className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-50"
                    title="立即检查新版本"
                  >
                    {checking ? "检查中…" : "检查更新"}
                  </button>
                }
              >
                <div className="mt-3 space-y-1 border-t border-border pt-3">
                  <label htmlFor="update-proxy" className="text-xs font-medium text-text">
                    更新代理
                  </label>
                  <input
                    id="update-proxy"
                    value={proxyDraft}
                    onChange={(event) => setProxyDraft(event.currentTarget.value)}
                    onBlur={commitProxy}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                    }}
                    placeholder="http://127.0.0.1:7897"
                    spellCheck={false}
                    className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text outline-none transition-colors focus:border-accent"
                  />
                  <p className="text-[11px] leading-relaxed text-text-muted/85">
                    留空则直连；只作用于检查与下载更新。可省略协议，按 http:// 处理。
                  </p>
                </div>
              </SettingsCard>
            )}
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
