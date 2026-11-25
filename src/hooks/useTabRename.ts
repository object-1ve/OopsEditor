import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "@/store/editor";
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
 * 顶部标签栏的文件重命名：标签名原地变成输入框，提交时改名磁盘文件，
 * 并同步所有指向旧路径的标签页、固定项与侧边栏。
 */
export function useTabRename() {
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

  return {
    renamingTabId: renaming?.tabId ?? null,
    draft,
    beginRename,
    updateDraft,
    commitRename,
    cancelRename,
  };
}
