/**
 * Tabs slice - file tab management
 */
import type { StateCreator } from "zustand";
import type { FileTab } from "@/types";
import type { EditorState, EditorPane, PinnedFile } from "@/store/types";
import { normalizePath, normalizePinnedFiles } from "@/utils/path";
import { clearScrollMemory } from "@/utils/scrollMemory";
import { fetchAndSetFileMtime } from "@/store/fileMtime";
import { invoke } from "@tauri-apps/api/core";
import { base64ToHexView } from "@/utils/hexView";
import { isPreviewOnlyLanguage, isChatTab } from "@/types";
import { CHAT_TAB_ID_PREFIX, chatTabId } from "@/components/chat/chatTab";
import {
  cancelScheduledTabPersist,
  persistActiveTabId,
  persistTabsState,
  persistSingleTabState,
  persistSingleTabStateNow,
  persistPinnedFilesState,
} from "@/utils/workspaceSession";
import { scheduleAutoSave, clearAutoSaveTimer, clearAutoSaveTimers } from "@/store/services/autoSave";
import { enforceTabLimit, formatAutoClosedTabsMessage } from "@/store/services/tabEnforcer";
import { evictExcelDoc } from "@/services/excelDocs";
import { evictNotebookDoc } from "@/services/notebookDocs";

/**
 * 编辑后的统一收尾：开启“编辑时自动保存”时安排一次延迟落盘。
 * 文本标签与 Excel 这类自行管理内容的标签共用同一节奏。
 */
function scheduleAutosaveAfterEdit(get: () => EditorState, id: string) {
  const state = get();
  if (!state.autoSaveOnEdit) return;
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab || !tab.path || tab.isReadOnly || tab.isPreviewMode) return;
  scheduleAutoSave(id, tab, (cleanId) => get().markClean(cleanId));
}

/**
 * 标签被顶替/关闭时释放它的运行期资源：滚动位置、自动保存计时器与文档缓存。
 */
function disposeTabResources(id: string) {
  clearScrollMemory(id);
  clearAutoSaveTimer(id);
  cancelScheduledTabPersist(id);
  evictExcelDoc(id);
  evictNotebookDoc(id);
}

export const createTabsSlice: StateCreator<
  EditorState,
  [],
  [],
  Pick<
    EditorState,
    | "tabs"
    | "activeTabId"
    | "openFiles"
    | "openChatSessionTab"
    | "openTab"
    | "openPreviewTab"
    | "pinTab"
    | "closeTab"
    | "closeTabs"
    | "closeOtherTabs"
    | "closeTabsToLeft"
    | "closeTabsToRight"
    | "setActiveTab"
    | "updateContent"
    | "markTabDirty"
    | "markClean"
    | "reloadTab"
    | "reloadTabFromDisk"
    | "replaceTabFileLocation"
    | "togglePreviewMode"
    | "toggleLivePreviewMode"
    | "toggleInstantRenderMode"
    | "pinFile"
    | "unpinFile"
    | "rebasePinnedFilePath"
    | "removePinnedFile"
    | "setPinnedFilesOrder"
    | "pinnedFiles"
    | "openTabInPane"
    | "closeTabInPane"
    | "closeTabsInPane"
    | "setActiveTabInPane"
  >
> = (set, get) => ({
  tabs: [],
  activeTabId: null,
  openFiles: [],
  pinnedFiles: [],

  openTab: (tab: FileTab) => {
    const state = get();
    if (tab.path && !isChatTab(tab)) {
      get().recordRecentFile(tab.path);
    }
    if (state.isSplit && state.focusedPane === "secondary") {
      get().openTabInPane(tab, "secondary");
      return;
    }
    set((state) => {
      const existing = state.tabs.find((t) => t.id === tab.id);
      if (existing) {
        void persistActiveTabId(tab.id);
        if (!existing.isPreviewTab) {
          return { activeTabId: tab.id };
        }
        // 再次以普通方式打开（如双击侧边栏文件）：预览标签转为固定标签
        return {
          activeTabId: tab.id,
          tabs: state.tabs.map((item) =>
            item.id === tab.id ? { ...item, isPreviewTab: false } : item,
          ),
        };
      }
      const limitedTabsState = enforceTabLimit(
        [...state.tabs, tab],
        tab.id,
        state.maxOpenTabs,
      );
      persistTabsState(limitedTabsState.tabs, limitedTabsState.activeTabId);
      limitedTabsState.closedTabs.forEach((closed) => cancelScheduledTabPersist(closed.id));
      if (limitedTabsState.closedTabs.length > 0) {
        queueMicrotask(() => {
          get().showNotification(formatAutoClosedTabsMessage(limitedTabsState.closedTabs), "info");
        });
      }
      return {
        tabs: limitedTabsState.tabs,
        activeTabId: limitedTabsState.activeTabId,
        openFiles: limitedTabsState.openFiles,
      };
    });
  },

  /**
   * 预览式打开（VS Code 行为）：单击侧边栏文件时调用。
   * 同一分栏只保留一个预览标签；新预览在原位顶替旧预览，不新增标签。
   * 已打开的标签只激活，不会把固定标签降级为预览。
   */
  openPreviewTab: (tab: FileTab) => {
    const state = get();
    if (tab.path && !isChatTab(tab)) {
      get().recordRecentFile(tab.path);
    }
    const pane: EditorPane =
      state.isSplit && state.focusedPane === "secondary" ? "secondary" : "primary";
    const targetTabs = pane === "secondary" ? state.secondaryTabs : state.tabs;
    const existing = targetTabs.find((t) => t.id === tab.id);
    if (existing) {
      if (pane === "secondary") {
        set({ secondaryActiveTabId: existing.id, focusedPane: "secondary" });
      } else {
        set({ activeTabId: existing.id });
        void persistActiveTabId(existing.id);
      }
      return;
    }

    const previewTab: FileTab = { ...tab, isPreviewTab: true };
    // 被顶替的预览标签按设计不会有未保存改动（编辑会立即固定它），dirty 时保险起见另开新标签
    const previewIndex = targetTabs.findIndex((t) => t.isPreviewTab && !t.isDirty);
    if (previewIndex !== -1) {
      disposeTabResources(targetTabs[previewIndex].id);
    }

    if (pane === "secondary") {
      const nextTabs = [...state.secondaryTabs];
      if (previewIndex !== -1) {
        nextTabs[previewIndex] = previewTab;
      } else {
        nextTabs.push(previewTab);
      }
      set({
        secondaryTabs: nextTabs,
        secondaryActiveTabId: previewTab.id,
        focusedPane: "secondary",
      });
      return;
    }

    if (previewIndex !== -1) {
      // 原位顶替不改变标签数量，无需触发上限裁剪
      const nextTabs = [...state.tabs];
      nextTabs[previewIndex] = previewTab;
      persistTabsState(nextTabs, previewTab.id);
      set({
        tabs: nextTabs,
        activeTabId: previewTab.id,
        openFiles: nextTabs.map((item) => item.path),
      });
      return;
    }

    set((current) => {
      const limitedTabsState = enforceTabLimit(
        [...current.tabs, previewTab],
        previewTab.id,
        current.maxOpenTabs,
      );
      persistTabsState(limitedTabsState.tabs, limitedTabsState.activeTabId);
      limitedTabsState.closedTabs.forEach((closed) => disposeTabResources(closed.id));
      if (limitedTabsState.closedTabs.length > 0) {
        queueMicrotask(() => {
          get().showNotification(formatAutoClosedTabsMessage(limitedTabsState.closedTabs), "info");
        });
      }
      return {
        tabs: limitedTabsState.tabs,
        activeTabId: limitedTabsState.activeTabId,
        openFiles: limitedTabsState.openFiles,
      };
    });
  },

  /** 固定预览标签；两个分栏中同 id 的标签一起固定 */
  pinTab: (id: string) =>
    set((state) => {
      const pin = (tab: FileTab) =>
        tab.id === id && tab.isPreviewTab ? { ...tab, isPreviewTab: false } : tab;
      return {
        tabs: state.tabs.map(pin),
        secondaryTabs: state.secondaryTabs.map(pin),
      };
    }),

  openChatSessionTab: (sessionId: number) => {
    const title = get().chatSessions.find((s) => s.id === sessionId)?.title ?? "";
    const tab: FileTab = {
      id: chatTabId(sessionId),
      name: title,
      path: `${CHAT_TAB_ID_PREFIX}${sessionId}`,
      language: "chat",
      content: "",
      isDirty: false,
      isReadOnly: true,
      kind: "chat",
    };
    set((state) => {
      const existing = state.tabs.find((t) => t.id === tab.id);
      if (existing) {
        void persistActiveTabId(tab.id);
        return { activeTabId: tab.id };
      }
      const limitedTabsState = enforceTabLimit(
        [...state.tabs, tab],
        tab.id,
        state.maxOpenTabs,
      );
      persistTabsState(limitedTabsState.tabs, limitedTabsState.activeTabId);
      limitedTabsState.closedTabs.forEach((closed) => cancelScheduledTabPersist(closed.id));
      return {
        tabs: limitedTabsState.tabs,
        activeTabId: limitedTabsState.activeTabId,
        openFiles: limitedTabsState.openFiles,
      };
    });
  },

  closeTab: (id: string) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id);
      const openFiles = tabs.map((tab) => tab.path);
      let activeTabId = state.activeTabId;
      if (activeTabId === id) {
        const idx = state.tabs.findIndex((t) => t.id === id);
        activeTabId = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? null;
      }
      clearScrollMemory(id);
      clearAutoSaveTimer(id);
      cancelScheduledTabPersist(id);
      evictExcelDoc(id);
      evictNotebookDoc(id);
      persistTabsState(tabs, activeTabId);
      return { tabs, openFiles, activeTabId };
    }),

  closeTabs: (ids: string[]) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => !ids.includes(t.id));
      const openFiles = tabs.map((tab) => tab.path);
      let activeTabId = state.activeTabId;
      if (activeTabId && ids.includes(activeTabId)) {
        activeTabId = tabs[tabs.length - 1]?.id ?? null;
      }
      ids.forEach((id) => clearScrollMemory(id));
      clearAutoSaveTimers(ids);
      ids.forEach((id) => cancelScheduledTabPersist(id));
      ids.forEach((id) => evictExcelDoc(id));
      ids.forEach((id) => evictNotebookDoc(id));
      persistTabsState(tabs, activeTabId);
      return { tabs, openFiles, activeTabId };
    }),

  closeOtherTabs: (id: string) => {
    const { tabs, closeTabs } = get();
    const idsToClose = tabs.filter((t) => t.id !== id).map((t) => t.id);
    closeTabs(idsToClose);
  },

  closeTabsToLeft: (id: string) => {
    const { tabs, closeTabs } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx > 0) {
      const idsToClose = tabs.slice(0, idx).map((t) => t.id);
      closeTabs(idsToClose);
    }
  },

  closeTabsToRight: (id: string) => {
    const { tabs, closeTabs } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx !== -1 && idx < tabs.length - 1) {
      const idsToClose = tabs.slice(idx + 1).map((t) => t.id);
      closeTabs(idsToClose);
    }
  },

  setActiveTab: (id: string) => {
    set({ activeTabId: id });
    void persistActiveTabId(id);
  },

  updateContent: (id: string, content: string) => {
    set((state) => {
      const newTabs = state.tabs.map((t) =>
        t.id === id ? { ...t, content, isDirty: true, isPreviewTab: false } : t,
      );
      const newSecondaryTabs = state.isSplit
        ? state.secondaryTabs.map((t) =>
            t.id === id ? { ...t, content, isDirty: true, isPreviewTab: false } : t,
          )
        : state.secondaryTabs;
      const updatedTab = newTabs.find((tab) => tab.id === id);
      const tabIndex = newTabs.findIndex((tab) => tab.id === id);
      if (updatedTab && tabIndex !== -1) {
        void persistSingleTabState(updatedTab, tabIndex);
      }
      return { tabs: newTabs, secondaryTabs: newSecondaryTabs };
    });

    scheduleAutosaveAfterEdit(get, id);
  },

  markTabDirty: (id: string) => {
    set((state) => {
      const markDirty = (t: FileTab) =>
        t.id === id ? { ...t, isDirty: true, isPreviewTab: false } : t;
      const newTabs = state.tabs.map(markDirty);
      const newSecondaryTabs = state.isSplit
        ? state.secondaryTabs.map(markDirty)
        : state.secondaryTabs;
      const updatedTab = newTabs.find((tab) => tab.id === id);
      const tabIndex = newTabs.findIndex((tab) => tab.id === id);
      if (updatedTab && tabIndex !== -1) {
        void persistSingleTabState(updatedTab, tabIndex);
      }
      return { tabs: newTabs, secondaryTabs: newSecondaryTabs };
    });

    scheduleAutosaveAfterEdit(get, id);
  },

  markClean: (id: string) => {
    clearAutoSaveTimer(id);
    set((state) => {
      const newTabs = state.tabs.map((t) =>
        t.id === id ? { ...t, isDirty: false } : t,
      );
      const newSecondaryTabs = state.isSplit
        ? state.secondaryTabs.map((t) =>
            t.id === id ? { ...t, isDirty: false } : t,
          )
        : state.secondaryTabs;
      const updatedTab = newTabs.find((tab) => tab.id === id);
      const tabIndex = newTabs.findIndex((tab) => tab.id === id);
      if (updatedTab && tabIndex !== -1) {
        // 保存完成要立刻把 is_dirty=false（以及大文件不再存内容）落库
        persistSingleTabStateNow(updatedTab, tabIndex);
      }
      return { tabs: newTabs, secondaryTabs: newSecondaryTabs };
    });
  },

  reloadTab: async (id: string, options?: { force?: boolean }): Promise<boolean> => {
    const state = get();
    const tab =
      state.tabs.find((t) => t.id === id) ??
      state.secondaryTabs.find((t) => t.id === id);
    if (!tab || !tab.path) return false;

    // 预览类模式（图片/PDF/Word/SQLite）：内容不在内存中，通过 revision 强制重新加载
    if (isPreviewOnlyLanguage(tab.language)) {
      clearAutoSaveTimer(id);
      set((state) => {
        const bump = (t: FileTab) =>
          t.id === id
            ? { ...t, revision: (t.revision ?? 0) + 1, isDirty: false }
            : t;
        return {
          tabs: state.tabs.map(bump),
          secondaryTabs: state.secondaryTabs.map(bump),
        };
      });
      return true;
    }

    try {
      let content = "";
      if (tab.viewMode === "base64") {
        const base64Content = await invoke<string>("read_file_as_base64", {
          path: tab.path,
        });
        content = base64ToHexView(base64Content);
      } else {
        content = await invoke<string>("read_file", { path: tab.path });
      }

      // 读取期间用户可能开始输入（isDirty 变为 true），此时不覆盖本地改动；
      // force（用户已确认丢弃改动）时即使 dirty 也强制应用磁盘内容
      const latest = get();
      const latestTab =
        latest.tabs.find((t) => t.id === id) ??
        latest.secondaryTabs.find((t) => t.id === id);
      if (!latestTab || (latestTab.isDirty && !options?.force)) return false;

      clearAutoSaveTimer(id);
      set((state) => {
        const replace = (t: FileTab) =>
          t.id === id ? { ...t, content, isDirty: false } : t;
        return {
          tabs: state.tabs.map(replace),
          secondaryTabs: state.secondaryTabs.map(replace),
        };
      });
      return true;
    } catch (err) {
      get().showNotification(`无法重新加载文件: ${String(err)}`, "error");
      return false;
    }
  },

  reloadTabFromDisk: (id: string) => {
    const state = get();
    const tab =
      state.tabs.find((t) => t.id === id) ??
      state.secondaryTabs.find((t) => t.id === id);
    if (!tab || !tab.path) return;

    const doReload = () => {
      void state.reloadTab(id, { force: true }).then((ok) => {
        if (!ok) return;
        // 刷新已知 mtime，避免轮询把本次手动重载误判为外部修改
        void fetchAndSetFileMtime(tab.path);
        state.showNotification(`已重新加载 "${tab.name}"`, "success");
      });
    };

    if (tab.isDirty) {
      state.showModal({
        title: "重新加载文件",
        message: `"${tab.name}" 有未保存的更改，重新加载将丢弃这些更改。确定要继续吗？`,
        kind: "warning",
        onConfirm: doReload,
      });
      return;
    }
    doReload();
  },

  replaceTabFileLocation: (id: string, nextPath: string, nextName?: string) =>
    set((state) => {
      const isPrimary = state.tabs.some((tab) => tab.id === id);
      const targetTab = isPrimary
        ? state.tabs.find((tab) => tab.id === id)
        : state.secondaryTabs.find((tab) => tab.id === id);

      const nextTabs = state.tabs.map((tab) => {
        if (tab.id !== id) return tab;
        return {
          ...tab,
          id: tab.viewMode === "base64" ? `${nextPath}#base64` : nextPath,
          path: nextPath,
          name: nextName ?? nextPath.split(/[/\\]/).pop() ?? tab.name,
          isDirty: false,
        };
      });

      const nextSecondaryTabs = state.secondaryTabs.map((tab) => {
        if (tab.id !== id) return tab;
        return {
          ...tab,
          id: tab.viewMode === "base64" ? `${nextPath}#base64` : nextPath,
          path: nextPath,
          name: nextName ?? nextPath.split(/[/\\]/).pop() ?? tab.name,
          isDirty: false,
        };
      });

      const nextPinnedFiles = targetTab
        ? normalizePinnedFiles(
            state.pinnedFiles.map((file) =>
              normalizePath(file.path) === normalizePath(targetTab.path)
                ? {
                    name: nextName ?? nextPath.split(/[/\\]/).pop() ?? file.name,
                    path: nextPath,
                  }
                : file,
            ),
          )
        : state.pinnedFiles;
      const nextActiveTabId = state.activeTabId === id ? nextPath : state.activeTabId;
      const nextSecondaryActiveTabId =
        state.secondaryActiveTabId === id ? nextPath : state.secondaryActiveTabId;
      const nextOpenFiles = nextTabs.map((tab) => tab.path);

      clearScrollMemory(id);
      // 标签 id 会换成新路径：别让旧 id 的去抖写入把刚删掉的行写回来
      cancelScheduledTabPersist(id);
      persistTabsState(nextTabs, nextActiveTabId);
      persistPinnedFilesState(nextPinnedFiles);

      return {
        tabs: nextTabs,
        secondaryTabs: nextSecondaryTabs,
        secondaryActiveTabId: nextSecondaryActiveTabId,
        activeTabId: nextActiveTabId,
        openFiles: nextOpenFiles,
        pinnedFiles: nextPinnedFiles,
      };
    }),

  togglePreviewMode: (id: string) =>
    set((state) => {
      const nextTabs = state.tabs.map((tab) => {
        if (tab.id !== id) return tab;
        const nextIsPreviewMode = !Boolean(tab.isPreviewMode);
        return {
          ...tab,
          isPreviewMode: nextIsPreviewMode,
          isLivePreviewMode: false,
          isInstantRenderMode: false,
        };
      });
      const updatedTab = nextTabs.find((tab) => tab.id === id);
      const tabIndex = nextTabs.findIndex((tab) => tab.id === id);
      if (updatedTab && tabIndex !== -1) {
        persistSingleTabStateNow(updatedTab, tabIndex);
      }
      return { tabs: nextTabs };
    }),

  toggleLivePreviewMode: (id: string) =>
    set((state) => {
      const nextTabs = state.tabs.map((tab) => {
        if (tab.id !== id) return tab;
        const nextIsLivePreviewMode = !Boolean(tab.isLivePreviewMode);
        return {
          ...tab,
          isPreviewMode: false,
          isLivePreviewMode: nextIsLivePreviewMode,
          isInstantRenderMode: false,
        };
      });
      const updatedTab = nextTabs.find((tab) => tab.id === id);
      const tabIndex = nextTabs.findIndex((tab) => tab.id === id);
      if (updatedTab && tabIndex !== -1) {
        persistSingleTabStateNow(updatedTab, tabIndex);
      }
      return { tabs: nextTabs };
    }),

  toggleInstantRenderMode: (id: string) =>
    set((state) => {
      const nextTabs = state.tabs.map((tab) => {
        if (tab.id !== id) return tab;
        const nextIsInstantRenderMode = !Boolean(tab.isInstantRenderMode);
        return {
          ...tab,
          isPreviewMode: false,
          isLivePreviewMode: false,
          isInstantRenderMode: nextIsInstantRenderMode,
        };
      });
      const updatedTab = nextTabs.find((tab) => tab.id === id);
      const tabIndex = nextTabs.findIndex((tab) => tab.id === id);
      if (updatedTab && tabIndex !== -1) {
        persistSingleTabStateNow(updatedTab, tabIndex);
      }
      return { tabs: nextTabs };
    }),

  pinFile: (file: PinnedFile) => {
    const normalizedPath = normalizePath(file.path);
    if (!normalizedPath) return;
    const nextPinnedFiles = normalizePinnedFiles([...get().pinnedFiles, file]);
    set({ pinnedFiles: nextPinnedFiles });
    persistPinnedFilesState(nextPinnedFiles);
  },

  unpinFile: (path: string) => {
    const normalizedPath = normalizePath(path);
    const nextPinnedFiles = get().pinnedFiles.filter(
      (item) => normalizePath(item.path) !== normalizedPath,
    );
    set({ pinnedFiles: nextPinnedFiles });
    persistPinnedFilesState(nextPinnedFiles);
  },

  rebasePinnedFilePath: (oldPath: string, newPath: string, nextName?: string) => {
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);
    if (!normalizedOldPath || !normalizedNewPath) return;
    const nextPinnedFiles = normalizePinnedFiles(
      get().pinnedFiles.map((file) =>
        normalizePath(file.path) === normalizedOldPath
          ? {
              name: nextName ?? newPath.split(/[/\\]/).pop() ?? file.name,
              path: newPath,
            }
          : file,
      ),
    );
    set({ pinnedFiles: nextPinnedFiles });
    persistPinnedFilesState(nextPinnedFiles);
  },

  removePinnedFile: (path: string) => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    const nextPinnedFiles = get().pinnedFiles.filter(
      (item) => normalizePath(item.path) !== normalizedPath,
    );
    set({ pinnedFiles: nextPinnedFiles });
    persistPinnedFilesState(nextPinnedFiles);
  },

  setPinnedFilesOrder: (files: PinnedFile[]) => {
    set({ pinnedFiles: files });
    persistPinnedFilesState(files);
  },

  // ── Split-pane tab operations ──

  openTabInPane: (tab, pane) => {
    if (pane === "primary") {
      get().openTab(tab);
      get().setFocusedPane("primary");
      return;
    }
    if (tab.path) {
      get().recordRecentFile(tab.path);
    }
    set((s) => {
      const existing = s.secondaryTabs.find((t) => t.id === tab.id);
      if (existing) {
        return {
          // 以普通方式再次打开时，预览标签转为固定标签
          secondaryTabs: existing.isPreviewTab
            ? s.secondaryTabs.map((t) =>
                t.id === tab.id ? { ...t, isPreviewTab: false } : t,
              )
            : s.secondaryTabs,
          secondaryActiveTabId: tab.id,
          focusedPane: "secondary",
        };
      }
      return {
        secondaryTabs: [...s.secondaryTabs, tab],
        secondaryActiveTabId: tab.id,
        focusedPane: "secondary",
      };
    });
  },

  closeTabInPane: (id, pane) => {
    if (pane === "primary") {
      get().closeTab(id);
      return;
    }
    set((state) => {
      const tabs = state.secondaryTabs.filter((t) => t.id !== id);
      let secondaryActiveTabId = state.secondaryActiveTabId;
      if (secondaryActiveTabId === id) {
        const idx = state.secondaryTabs.findIndex((t) => t.id === id);
        secondaryActiveTabId = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? null;
      }
      clearScrollMemory(id);
      evictExcelDoc(id);
      evictNotebookDoc(id);
      return { secondaryTabs: tabs, secondaryActiveTabId };
    });
  },

  closeTabsInPane: (ids, pane) => {
    if (pane === "primary") {
      get().closeTabs(ids);
      return;
    }
    set((state) => {
      const tabs = state.secondaryTabs.filter((t) => !ids.includes(t.id));
      let secondaryActiveTabId = state.secondaryActiveTabId;
      if (secondaryActiveTabId && ids.includes(secondaryActiveTabId)) {
        secondaryActiveTabId = tabs[tabs.length - 1]?.id ?? null;
      }
      ids.forEach((id) => clearScrollMemory(id));
      ids.forEach((id) => evictExcelDoc(id));
      ids.forEach((id) => evictNotebookDoc(id));
      return { secondaryTabs: tabs, secondaryActiveTabId };
    });
  },

  setActiveTabInPane: (id, pane) => {
    if (pane === "primary") {
      get().setActiveTab(id);
      get().setFocusedPane("primary");
      return;
    }
    set({ secondaryActiveTabId: id, focusedPane: "secondary" });
  },
});
