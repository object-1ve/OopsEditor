import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "@/store/editor";
import type { EditorPane } from "@/store/types";
import { isChatTab, type FileTab } from "@/types";
import { normalizePath } from "@/utils/path";

/** 正在重命名的标签页：记录旧路径与旧文件名，提交时据此算出新路径 */
interface RenameTarget {
  tabId: string;
  path: string;
  name: string;
}

/** Windows 文件名非法字符（斜杠单独判，给出更明确的提示） */
const INVALID_NAME_CHARS = /[<>:"|?*]/;

/** 拆出文件所在目录（保留原始分隔符），用于拼新路径与刷新侧边栏 */
const splitParentPath = (path: string) => {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return {
    parent: path.slice(0, index + 1),
    dir: path.slice(0, index) || path.slice(0, index + 1),
  };
};

/**
 * 焦点是否落在不该被 F2 抢占的可编辑控件上：
 * Monaco 是唯一要接管的可编辑区域（在编辑器内按 F2 重命名文件名），
 * 终端（xterm）与其他输入框/文本域/下拉框保留各自的 F2 语义。
 */
function shouldIgnoreF2Target(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(".xterm")) return true;
  if (target.closest(".monaco-editor")) return false;
  const element = target as HTMLElement;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable
  );
}

/**
 * 顶部标签栏的文件重命名：标签名原地变成输入框，提交时改名磁盘文件，
 * 并同步所有指向旧路径的标签页、固定项与侧边栏。
 *
 * `pane` 决定 F2 作用于哪个分区的活动标签：分屏时只有聚焦分区响应。
 */
export interface TabRenameHandle {
  /** 正在重命名的标签 id；没有则为 null */
  renamingTabId: string | null;
  /** 重命名输入框的当前草稿 */
  draft: string;
  beginRename: (tab: FileTab) => void;
  updateDraft: (value: string) => void;
  commitRename: () => Promise<void>;
  cancelRename: () => void;
}

export function useTabRename(pane: EditorPane = "primary"): TabRenameHandle {
  const replaceTabFileLocation = useEditorStore((s) => s.replaceTabFileLocation);
  const rebasePinnedFilePath = useEditorStore((s) => s.rebasePinnedFilePath);
  const showNotification = useEditorStore((s) => s.showNotification);

  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const [draft, setDraft] = useState("");
  // 供 blur/Enter 读取最新值：事件回调里拿到的闭包状态可能已过期
  const targetRef = useRef<RenameTarget | null>(null);
  const draftRef = useRef("");

  const beginRename = useCallback((tab: FileTab) => {
    // 会话标签没有磁盘文件，不能重命名
    if (isChatTab(tab) || !tab.path) return;
    const target = { tabId: tab.id, path: tab.path, name: tab.name };
    targetRef.current = target;
    draftRef.current = tab.name;
    setRenaming(target);
    setDraft(tab.name);
  }, []);

  const cancelRename = useCallback(() => {
    targetRef.current = null;
    draftRef.current = "";
    setRenaming(null);
    setDraft("");
  }, []);

  const updateDraft = useCallback((value: string) => {
    draftRef.current = value;
    setDraft(value);
  }, []);

  const commitRename = useCallback(async () => {
    const target = targetRef.current;
    if (!target) return;
    // 先清空，避免 Enter 提交后输入框卸载触发 blur 再提交一次
    targetRef.current = null;
    setRenaming(null);

    const nextName = draftRef.current.trim();
    if (!nextName || nextName === target.name) return;
    if (/[\\/]/.test(nextName)) {
      showNotification("文件名不能包含路径分隔符", "error");
      return;
    }
    if (INVALID_NAME_CHARS.test(nextName) || /[. ]$/.test(nextName)) {
      showNotification("文件名包含非法字符，或以点/空格结尾", "error");
      return;
    }

    const { parent, dir } = splitParentPath(target.path);
    const newPath = `${parent}${nextName}`;
    if (normalizePath(newPath) === normalizePath(target.path)) return;

    try {
      await invoke("rename_item", { path: target.path, newPath });
    } catch (err) {
      showNotification(String(err), "error");
      return;
    }

    rebasePinnedFilePath(target.path, newPath, nextName);
    // 同一文件可能同时开在两个分区：逐个同步，重命名不清除未保存标记
    const state = useEditorStore.getState();
    [...state.tabs, ...state.secondaryTabs]
      .filter((tab) => normalizePath(tab.path) === normalizePath(target.path))
      .forEach((tab) =>
        replaceTabFileLocation(tab.id, newPath, nextName, { preserveDirty: true }),
      );

    window.dispatchEvent(new CustomEvent("file-refresh", { detail: { path: dir } }));
    showNotification(`已重命名为 ${nextName}`, "success");
  }, [rebasePinnedFilePath, replaceTabFileLocation, showNotification]);

  // F2：重命名当前分区活动标签对应的磁盘文件。挂在 window 捕获阶段，
  // 抢在 Monaco/浏览器的默认 F2 之前，避免编辑器把按键吃掉。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F2" || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      // 已在重命名：本次按键继续交给输入框处理
      if (targetRef.current) return;
      if (shouldIgnoreF2Target(event.target)) return;

      const state = useEditorStore.getState();
      // 未分屏时副分区不可见，只让主分区响应
      if (!state.isSplit && pane === "secondary") return;
      // 分屏时只响应聚焦分区，避免两个标签栏同时进入重命名
      if (state.isSplit && state.focusedPane !== pane) return;
      // 设置/搜索/确认弹窗打开时不打断
      if (state.isSettingsOpen || state.isSearchOpen || state.modal) return;

      const activeId = pane === "secondary" ? state.secondaryActiveTabId : state.activeTabId;
      const paneTabs = pane === "secondary" ? state.secondaryTabs : state.tabs;
      const tab = paneTabs.find((item) => item.id === activeId);
      if (!tab || isChatTab(tab) || !tab.path) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      beginRename(tab);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [beginRename, pane]);

  return {
    renamingTabId: renaming?.tabId ?? null,
    draft,
    beginRename,
    updateDraft,
    commitRename,
    cancelRename,
  };
}
