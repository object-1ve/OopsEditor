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
import { isPreviewOnlyLanguage } from "@/types";
import {
  persistActiveTabId,
  persistTabsState,
  persistSingleTabState,
  persistPinnedFilesState,
} from "@/utils/workspaceSession";
import { scheduleAutoSave, clearAutoSaveTimer, clearAutoSaveTimers } from "@/store/services/autoSave";
import { enforceTabLimit, formatAutoClosedTabsMessage } from "@/store/services/tabEnforcer";

export const createTabsSlice: StateCreator<
  EditorState,
  [],
  [],
  Pick<
    EditorState,
    | "tabs"
    | "activeTabId"
    | "openFiles"
    | "openTab"
    | "closeTab"
    | "closeTabs"
    | "closeOtherTabs"
    | "closeTabsToLeft"
    | "closeTabsToRight"
    | "setActiveTab"
    | "updateContent"
    | "markClean"
    | "reloadTab"
    | "reloadTabFromDisk"
    | "replaceTabFileLocation"
    | "togglePreviewMode"
    | "toggleLivePreviewMode"
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
    if (tab.path) {
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
        return { activeTabId: tab.id };
      }
      const limitedTabsState = enforceTabLimit(
        [...state.tabs, tab],
        tab.id,
        state.maxOpenTabs,
      );
      persistTabsState(limitedTabsState.tabs, limitedTabsState.activeTabId);
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
        t.id === id ? { ...t, content, isDirty: true } : t,
      );
      const newSecondaryTabs = state.isSplit
        ? state.secondaryTabs.map((t) =>
            t.id === id ? { ...t, content, isDirty: true } : t,
          )
        : state.secondaryTabs;
      const updatedTab = newTabs.find((tab) => tab.id === id);
      const tabIndex = newTabs.findIndex((tab) => tab.id === id);
      if (updatedTab && tabIndex !== -1) {
        void persistSingleTabState(updatedTab, tabIndex);
      }
      return { tabs: newTabs, secondaryTabs: newSecondaryTabs };
    });

    const state = get();
    if (!state.autoSaveOnEdit) return;
    const tab = state.tabs.find((t) => t.id === id);
    if (!tab || !tab.path || tab.isReadOnly) return;
    if (tab.isPreviewMode) return;

    scheduleAutoSave(id, tab, (cleanId) => get().markClean(cleanId));
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
        void persistSingleTabState(updatedTab, tabIndex);
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
        return { ...tab, isPreviewMode: nextIsPreviewMode, isLivePreviewMode: false };
      });
      const updatedTab = nextTabs.find((tab) => tab.id === id);
      const tabIndex = nextTabs.findIndex((tab) => tab.id === id);
      if (updatedTab && tabIndex !== -1) {
        void persistSingleTabState(updatedTab, tabIndex);
      }
      return { tabs: nextTabs };
    }),

  toggleLivePreviewMode: (id: string) =>
    set((state) => {
      const nextTabs = state.tabs.map((tab) => {
        if (tab.id !== id) return tab;
        const nextIsLivePreviewMode = !Boolean(tab.isLivePreviewMode);
        return { ...tab, isPreviewMode: false, isLivePreviewMode: nextIsLivePreviewMode };
      });
      const updatedTab = nextTabs.find((tab) => tab.id === id);
      const tabIndex = nextTabs.findIndex((tab) => tab.id === id);
      if (updatedTab && tabIndex !== -1) {
        void persistSingleTabState(updatedTab, tabIndex);
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
      if (s.secondaryTabs.some((t) => t.id === tab.id)) {
        return { secondaryActiveTabId: tab.id, focusedPane: "secondary" };
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
