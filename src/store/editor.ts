import { create } from "zustand";
import type { FileTab } from "../types";
import {
  DEFAULT_MAX_OPEN_TABS,
  loadSettings,
  sanitizeMaxOpenTabs,
  saveSetting,
} from "../utils/settings";
import {
  persistActiveTabId,
  persistDefaultFoldersState,
  persistExpandedFoldersState,
  persistPinnedFilesState,
  persistPinnedFoldersState,
  persistRootPathsState,
  persistSingleTabState,
  persistTabsState,
} from "../utils/workspaceSession";
import { base64ToHexView, parseHexView } from "../utils/hexView";
import { clearScrollMemory } from "../utils/scrollMemory";
import { saveTab } from "../services/editorSave";
import { appDataDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";

const AUTO_SAVE_DELAY = 1000;
const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearAutoSaveTimer(tabId: string) {
  const timer = autoSaveTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    autoSaveTimers.delete(tabId);
  }
}

function clearAutoSaveTimers(tabIds: string[]) {
  tabIds.forEach(clearAutoSaveTimer);
}

const normalizePath = (path: string) => {
  if (!path) return "";
  let normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  if (/^[a-z]:/i.test(normalized)) {
    normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  return normalized;
};

const normalizeUniquePaths = (paths: string[]) =>
  Array.from(new Set(paths.map(normalizePath).filter(Boolean)));

function enforceTabLimit(
  tabs: FileTab[],
  activeTabId: string | null,
  maxOpenTabs: number,
) {
  const sanitizedMaxOpenTabs = sanitizeMaxOpenTabs(maxOpenTabs);
  const nextTabs = [...tabs];
  const closedTabs: FileTab[] = [];

  while (nextTabs.length > sanitizedMaxOpenTabs) {
    const firstCleanTabIndex = nextTabs.findIndex((tab) => !tab.isDirty);
    if (firstCleanTabIndex === -1) {
      break;
    }

    const [closedTab] = nextTabs.splice(firstCleanTabIndex, 1);
    if (closedTab) {
      closedTabs.push(closedTab);
    }
  }

  let nextActiveTabId = activeTabId;
  if (nextActiveTabId && !nextTabs.some((tab) => tab.id === nextActiveTabId)) {
    nextActiveTabId = nextTabs[nextTabs.length - 1]?.id ?? null;
  }

  return {
    tabs: nextTabs,
    activeTabId: nextActiveTabId,
    openFiles: nextTabs.map((tab) => tab.path),
    closedTabs,
  };
}

function formatAutoClosedTabsMessage(closedTabs: FileTab[]) {
  if (closedTabs.length === 0) {
    return "";
  }

  const previewNames = closedTabs
    .slice(0, 2)
    .map((tab) => tab.name)
    .join("、");

  if (closedTabs.length === 1) {
    return `已自动关闭未修改标签：${previewNames}`;
  }

  const remainingCount = closedTabs.length - 2;
  const suffix = remainingCount > 0 ? ` 等 ${closedTabs.length} 个标签` : ` 共 ${closedTabs.length} 个标签`;
  return `已自动关闭未修改标签：${previewNames}${suffix}`;
}

export interface TerminalInstance {
  id: string;
  name: string;
  path: string | null;
}

export interface DefaultFolder {
  id: string;
  name: string;
  path: string;
}

export interface PinnedFile {
  name: string;
  path: string;
}

export interface MarkdownOutlineTarget {
  tabId: string;
  headingId: string;
  line: number;
}

export type EditorPane = "primary" | "secondary";

const normalizePinnedFiles = (files: PinnedFile[]) => {
  const seen = new Set<string>();
  const normalizedFiles: PinnedFile[] = [];

  for (const file of files) {
    const normalizedPath = normalizePath(file.path);
    if (!normalizedPath || seen.has(normalizedPath)) {
      continue;
    }

    seen.add(normalizedPath);
    normalizedFiles.push({
      name: file.name || file.path.split(/[/\\]/).pop() || normalizedPath,
      path: file.path,
    });
  }

  return normalizedFiles;
};

interface EditorState {
  tabs: FileTab[];
  activeTabId: string | null;
  openFiles: string[];
  rootPaths: string[];
  defaultFolders: DefaultFolder[];
  pinnedFiles: PinnedFile[];
  isLeftSidebarCollapsed: boolean;
  isRightSidebarCollapsed: boolean;
  isTerminalVisible: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  terminalHeight: number;
  editorWordWrap: boolean;
  autoSaveOnEdit: boolean;
  maxOpenTabs: number;
  isSettingsOpen: boolean;
  terminals: TerminalInstance[];
  activeTerminalId: string | null;
  modal: {
    title: string;
    message: string;
    onConfirm: () => void;
    onCancel?: () => void;
    kind?: "warning" | "danger" | "info";
  } | null;
  notification: { message: string; type: "info" | "error" | "success" } | null;
  expandedFolders: string[];
  pinnedFolders: string[];
  hoveredPath: string | null;
  markdownOutlineTarget: MarkdownOutlineTarget | null;
  rightSidebarIconOrder: string[];
  sidebarSortField: 'name' | 'modified';
  sidebarSortOrder: 'asc' | 'desc';
  rootPathOrder: string[];
  isSplit: boolean;
  secondaryTabs: FileTab[];
  secondaryActiveTabId: string | null;
  focusedPane: EditorPane;
  splitRatio: number;

  init: () => Promise<void>;
  setHoveredPath: (path: string | null) => void;
  openTab: (tab: FileTab) => void;
  closeTab: (id: string) => void;
  closeTabs: (ids: string[]) => void;
  closeOtherTabs: (id: string) => void;
  closeTabsToLeft: (id: string) => void;
  closeTabsToRight: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateContent: (id: string, content: string) => void;
  markClean: (id: string) => void;
  replaceTabFileLocation: (id: string, nextPath: string, nextName?: string) => void;
  addRootPath: (path: string) => void;
  removeRootPath: (path: string) => void;
  setDefaultFolders: (folders: DefaultFolder[]) => void;
  updateDefaultFolder: (id: string, path: string, name?: string) => void;
  addDefaultFolder: (name: string, path: string) => void;
  removeDefaultFolder: (id: string) => void;
  pinFile: (file: PinnedFile) => void;
  unpinFile: (path: string) => void;
  rebasePinnedFilePath: (oldPath: string, newPath: string, nextName?: string) => void;
  removePinnedFile: (path: string) => void;
  pinFolder: (path: string) => void;
  unpinFolder: (path: string) => void;
  rebasePinnedFolderPaths: (oldPath: string, newPath: string) => void;
  removePinnedFoldersUnder: (path: string) => void;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  setLeftSidebarWidth: (width: number) => void;
  setRightSidebarWidth: (width: number) => void;
  setTerminalHeight: (height: number) => void;
  setEditorWordWrap: (enabled: boolean) => void;
  setAutoSaveOnEdit: (enabled: boolean) => void;
  setMaxOpenTabs: (value: number) => void;
  openSettings: () => void;
  closeSettings: () => void;
  addTerminal: (path?: string | null) => void;
  removeTerminal: (id: string) => void;
  closeTerminals: (ids: string[]) => void;
  closeOtherTerminals: (id: string) => void;
  closeTerminalsToLeft: (id: string) => void;
  closeTerminalsToRight: (id: string) => void;
  setActiveTerminal: (id: string) => void;
  showModal: (config: { title: string; message: string; onConfirm: () => void; onCancel?: () => void; kind?: "warning" | "danger" | "info" }) => void;
  closeModal: () => void;
  showNotification: (message: string, type?: "info" | "error" | "success") => void;
  clearNotification: () => void;
  togglePreviewMode: (id: string) => void;
  toggleLivePreviewMode: (id: string) => void;
  toggleFolderExpanded: (path: string) => void;
  setFolderExpanded: (path: string, expanded: boolean) => void;
  collapseAllFolders: () => void;
  navigateToMarkdownHeading: (target: MarkdownOutlineTarget) => void;
  clearMarkdownOutlineTarget: () => void;
  setRightSidebarIconOrder: (order: string[]) => void;
  setSidebarSortField: (field: 'name' | 'modified') => void;
  setSidebarSortOrder: (order: 'asc' | 'desc') => void;
  setRootPathOrder: (order: string[]) => void;
  toggleSplit: () => void;
  setSplit: (enabled: boolean) => void;
  setFocusedPane: (pane: EditorPane) => void;
  setSplitRatio: (ratio: number) => void;
  openTabInPane: (tab: FileTab, pane: EditorPane) => void;
  closeTabInPane: (id: string, pane: EditorPane) => void;
  closeTabsInPane: (ids: string[], pane: EditorPane) => void;
  setActiveTabInPane: (id: string, pane: EditorPane) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  openFiles: [],
  rootPaths: [],
  defaultFolders: [],
  pinnedFiles: [],
  isLeftSidebarCollapsed: false,
  isRightSidebarCollapsed: false,
  isTerminalVisible: false,
  leftSidebarWidth: 220,
  rightSidebarWidth: 40,
  terminalHeight: 300,
  editorWordWrap: false,
  autoSaveOnEdit: false,
  maxOpenTabs: DEFAULT_MAX_OPEN_TABS,
  isSettingsOpen: false,
  terminals: [],
  activeTerminalId: null,
  modal: null,
  notification: null,
  expandedFolders: [],
  pinnedFolders: [],
  hoveredPath: null,
  markdownOutlineTarget: null,
  rightSidebarIconOrder: ["info", "git", "outline", "help"],
  sidebarSortField: 'modified',
  sidebarSortOrder: 'desc',
  rootPathOrder: [],
  isSplit: false,
  secondaryTabs: [],
  secondaryActiveTabId: null,
  focusedPane: 'primary',
  splitRatio: 0.5,

  init: async () => {
    const settings = await loadSettings();
    const normalizedTabs = (settings.tabs || []).map((tab) => {
      if (tab.viewMode !== "base64") {
        return tab;
      }

      const parsedHex = parseHexView(tab.content);
      const nextContent = parsedHex.error ? base64ToHexView(tab.content) : tab.content;

      return {
        ...tab,
        content: nextContent,
        isReadOnly: false,
      };
    });

    let defaultFolders = settings.defaultFolders;
    if (!defaultFolders || defaultFolders.length === 0) {
      try {
        const path = await appDataDir();
        // 默认显示 AppData/Roaming 下的文件夹，并以项目名命名
        const name = path.split(/[/\\]/).filter(Boolean).pop() || 'AppData';
        defaultFolders = [
          { id: 'default-appdata', name, path }
        ];
      } catch (err) {
        console.error("Failed to get app data dir:", err);
        // Fallback to src if appDataDir fails
        defaultFolders = [
          { id: 'default-src', name: 'src', path: 'd:/Desktop/oops_try/OopsEditor/src' }
        ];
      }
    }

    const limitedTabsState = enforceTabLimit(
      normalizedTabs,
      settings.activeTabId,
      settings.maxOpenTabs,
    );

    const rightSidebarIconOrder = settings.rightSidebarIconOrder || ["info", "git", "outline", "help"];
    if (!rightSidebarIconOrder.includes("git")) {
      // 如果没有 git，插入到 info 后面
      const infoIdx = rightSidebarIconOrder.indexOf("info");
      if (infoIdx !== -1) {
        rightSidebarIconOrder.splice(infoIdx + 1, 0, "git");
      } else {
        rightSidebarIconOrder.unshift("git");
      }
    }

    set({
      isLeftSidebarCollapsed: settings.isLeftSidebarCollapsed,
      isRightSidebarCollapsed: settings.isRightSidebarCollapsed,
      isTerminalVisible: settings.isTerminalVisible || false,
      leftSidebarWidth: settings.leftSidebarWidth,
      rightSidebarWidth: settings.rightSidebarWidth,
      terminalHeight: settings.terminalHeight || 300,
      editorWordWrap: settings.editorWordWrap,
      autoSaveOnEdit: settings.autoSaveOnEdit,
      maxOpenTabs: settings.maxOpenTabs,
      defaultFolders,
      pinnedFiles: normalizePinnedFiles(settings.pinnedFiles || []),
      tabs: limitedTabsState.tabs,
      activeTabId: limitedTabsState.activeTabId,
      rootPaths: settings.rootPaths || [],
      expandedFolders: settings.expandedFolders || [],
      pinnedFolders: normalizeUniquePaths(settings.pinnedFolders || []),
      openFiles: limitedTabsState.openFiles,
      rightSidebarIconOrder,
      sidebarSortField: settings.sidebarSortField,
      sidebarSortOrder: settings.sidebarSortOrder,
      rootPathOrder: settings.rootPathOrder || settings.rootPaths || [],
    });

    if (
      limitedTabsState.tabs.length !== normalizedTabs.length ||
      limitedTabsState.activeTabId !== settings.activeTabId
    ) {
      persistTabsState(limitedTabsState.tabs, limitedTabsState.activeTabId);
    }

    if (limitedTabsState.closedTabs.length > 0) {
      get().showNotification(formatAutoClosedTabsMessage(limitedTabsState.closedTabs), "info");
    }
  },

  setHoveredPath: (path: string | null) => set({ hoveredPath: path }),

  openTab: (tab: FileTab) => {
    // 分屏且焦点在副窗口时，新标签开到副窗口
    const state = get();
    if (state.isSplit && state.focusedPane === 'secondary') {
      get().openTabInPane(tab, 'secondary');
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
        t.id === id ? { ...t, content, isDirty: true } : t
      );
      // 分屏时同步更新副窗口中同一标签，保证两侧内容实时一致
      const newSecondaryTabs = state.isSplit
        ? state.secondaryTabs.map((t) =>
            t.id === id ? { ...t, content, isDirty: true } : t
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
    // 预览/只读类语言不支持回写
    if (tab.isPreviewMode) return;

    clearAutoSaveTimer(id);
    autoSaveTimers.set(
      id,
      setTimeout(() => {
        autoSaveTimers.delete(id);
        const latest = get().tabs.find((t) => t.id === id);
        if (!latest || !latest.isDirty) return;
        void saveTab(latest)
          .then(() => {
            get().markClean(id);
            window.dispatchEvent(
              new CustomEvent("file-refresh", { detail: { path: latest.path } }),
            );
          })
          .catch((err) => {
            console.error(`自动保存失败 ${latest.name}:`, err);
          });
      }, AUTO_SAVE_DELAY),
    );
  },

  markClean: (id: string) => {
    clearAutoSaveTimer(id);
    set((state) => {
      const newTabs = state.tabs.map((t) =>
        t.id === id ? { ...t, isDirty: false } : t
      );
      const newSecondaryTabs = state.isSplit
        ? state.secondaryTabs.map((t) =>
            t.id === id ? { ...t, isDirty: false } : t
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

  replaceTabFileLocation: (id: string, nextPath: string, nextName?: string) =>
    set((state) => {
      const targetTab = state.tabs.find((tab) => tab.id === id);
      const nextTabs = state.tabs.map((tab) => {
        if (tab.id !== id) {
          return tab;
        }

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
      const nextOpenFiles = nextTabs.map((tab) => tab.path);

      clearScrollMemory(id);
      persistTabsState(nextTabs, nextActiveTabId);
      persistPinnedFilesState(nextPinnedFiles);

      return {
        tabs: nextTabs,
        activeTabId: nextActiveTabId,
        openFiles: nextOpenFiles,
        pinnedFiles: nextPinnedFiles,
      };
    }),

  addRootPath: (path: string) =>
    set((state) => {
      const normalizedPath = normalizePath(path);
      const newRootPaths = state.rootPaths.includes(normalizedPath)
        ? state.rootPaths
        : [...state.rootPaths, normalizedPath];

      const newRootPathOrder = state.rootPathOrder.includes(normalizedPath)
        ? state.rootPathOrder
        : [...state.rootPathOrder, normalizedPath];

      const newExpanded = state.expandedFolders.includes(normalizedPath)
        ? state.expandedFolders
        : [...state.expandedFolders, normalizedPath];

      void persistRootPathsState(newRootPaths);
      void saveSetting('rootPathOrder', newRootPathOrder);
      void invoke("record_project_opened", { path: normalizedPath });
      persistExpandedFoldersState(newExpanded);
      return { rootPaths: newRootPaths, rootPathOrder: newRootPathOrder, expandedFolders: newExpanded };
    }),

  removeRootPath: (path: string) =>
    set((state) => {
      const newRootPaths = state.rootPaths.filter((p) => p !== path);
      const newRootPathOrder = state.rootPathOrder.filter((p) => p !== path);
      void persistRootPathsState(newRootPaths);
      void saveSetting('rootPathOrder', newRootPathOrder);
      return { rootPaths: newRootPaths, rootPathOrder: newRootPathOrder };
    }),

  setDefaultFolders: (folders: DefaultFolder[]) => {
    set({ defaultFolders: folders });
    void persistDefaultFoldersState(folders);
  },

  updateDefaultFolder: (id: string, path: string, name?: string) => {
    const folders = get().defaultFolders.map(f =>
      f.id === id ? { ...f, path, name: name || path.split(/[/\\]/).pop() || f.name } : f
    );
    set({ defaultFolders: folders });
    void persistDefaultFoldersState(folders);
  },

  addDefaultFolder: (name: string, path: string) => {
    const newFolder = { id: crypto.randomUUID(), name, path };
    const folders = [...get().defaultFolders, newFolder];
    set({ defaultFolders: folders });
    void persistDefaultFoldersState(folders);
  },

  removeDefaultFolder: (id: string) => {
    const folders = get().defaultFolders.filter(f => f.id !== id);
    set({ defaultFolders: folders });
    void persistDefaultFoldersState(folders);
  },

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
      (item) => normalizePath(item.path) !== normalizedPath
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
      (item) => normalizePath(item.path) !== normalizedPath
    );
    set({ pinnedFiles: nextPinnedFiles });
    persistPinnedFilesState(nextPinnedFiles);
  },

  pinFolder: (path: string) => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;

    const pinnedFolders = get().pinnedFolders;
    if (pinnedFolders.includes(normalizedPath)) return;

    const nextPinnedFolders = normalizeUniquePaths([...pinnedFolders, normalizedPath]);
    set({ pinnedFolders: nextPinnedFolders });
    persistPinnedFoldersState(nextPinnedFolders);
  },

  unpinFolder: (path: string) => {
    const normalizedPath = normalizePath(path);
    const nextPinnedFolders = get().pinnedFolders.filter((item) => item !== normalizedPath);
    set({ pinnedFolders: nextPinnedFolders });
    persistPinnedFoldersState(nextPinnedFolders);
  },

  rebasePinnedFolderPaths: (oldPath: string, newPath: string) => {
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);
    if (!normalizedOldPath || !normalizedNewPath) return;

    const nextPinnedFolders = normalizeUniquePaths(get().pinnedFolders.map((item) => {
      if (item === normalizedOldPath) {
        return normalizedNewPath;
      }

      if (item.startsWith(`${normalizedOldPath}/`)) {
        return `${normalizedNewPath}${item.slice(normalizedOldPath.length)}`;
      }

      return item;
    }));

    set({ pinnedFolders: nextPinnedFolders });
    persistPinnedFoldersState(nextPinnedFolders);
  },

  removePinnedFoldersUnder: (path: string) => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;

    const nextPinnedFolders = get().pinnedFolders.filter(
      (item) => item !== normalizedPath && !item.startsWith(`${normalizedPath}/`)
    );

    set({ pinnedFolders: nextPinnedFolders });
    persistPinnedFoldersState(nextPinnedFolders);
  },

  toggleLeftSidebar: () => {
    const newValue = !get().isLeftSidebarCollapsed;
    set({ isLeftSidebarCollapsed: newValue });
    saveSetting('isLeftSidebarCollapsed', newValue);
  },
  toggleRightSidebar: () => {
    const newValue = !get().isRightSidebarCollapsed;
    set({ isRightSidebarCollapsed: newValue });
    saveSetting('isRightSidebarCollapsed', newValue);
  },
  toggleTerminal: () => {
    const { isTerminalVisible, terminals, addTerminal } = get();
    const newValue = !isTerminalVisible;

    // 如果要打开终端且当前没有终端，则创建一个
    if (newValue && terminals.length === 0) {
      addTerminal();
    }

    set({ isTerminalVisible: newValue });
    saveSetting('isTerminalVisible', newValue);
  },
  setTerminalVisible: (visible: boolean) => {
    set({ isTerminalVisible: visible });
    saveSetting('isTerminalVisible', visible);
  },
  setLeftSidebarWidth: (width: number) => {
    set({ leftSidebarWidth: width });
    saveSetting('leftSidebarWidth', width);
  },
  setRightSidebarWidth: (width: number) => {
    set({ rightSidebarWidth: width });
    saveSetting('rightSidebarWidth', width);
  },
  setTerminalHeight: (height: number) => {
    set({ terminalHeight: height });
    saveSetting('terminalHeight', height);
  },
  setEditorWordWrap: (enabled: boolean) => {
    set({ editorWordWrap: enabled });
    saveSetting('editorWordWrap', enabled);
  },
  setAutoSaveOnEdit: (enabled: boolean) => {
    set({ autoSaveOnEdit: enabled });
    saveSetting('autoSaveOnEdit', enabled);
    if (!enabled) {
      clearAutoSaveTimers([...autoSaveTimers.keys()]);
    }
  },
  setMaxOpenTabs: (value: number) => {
    const nextMaxOpenTabs = sanitizeMaxOpenTabs(value);
    const limitedTabsState = enforceTabLimit(
      get().tabs,
      get().activeTabId,
      nextMaxOpenTabs,
    );

    set({
      maxOpenTabs: nextMaxOpenTabs,
      tabs: limitedTabsState.tabs,
      activeTabId: limitedTabsState.activeTabId,
      openFiles: limitedTabsState.openFiles,
    });
    void saveSetting('maxOpenTabs', nextMaxOpenTabs);
    persistTabsState(limitedTabsState.tabs, limitedTabsState.activeTabId);
    if (limitedTabsState.closedTabs.length > 0) {
      get().showNotification(formatAutoClosedTabsMessage(limitedTabsState.closedTabs), "info");
    }
  },
  openSettings: () => set({ isSettingsOpen: true }),
  closeSettings: () => set({ isSettingsOpen: false }),

  addTerminal: (path: string | null = null) => {
    const id = crypto.randomUUID();
    const newTerminal: TerminalInstance = {
      id,
      name: `终端 ${get().terminals.length + 1}`,
      path: path || get().rootPaths[0] || null,
    };
    set((state) => ({
      terminals: [...state.terminals, newTerminal],
      activeTerminalId: id,
      isTerminalVisible: true,
    }));
    saveSetting('isTerminalVisible', true);
  },

  removeTerminal: (id: string) => {
    set((state) => {
      const terminals = state.terminals.filter((t) => t.id !== id);
      let activeTerminalId = state.activeTerminalId;
      if (activeTerminalId === id) {
        const idx = state.terminals.findIndex((t) => t.id === id);
        activeTerminalId = terminals[idx]?.id ?? terminals[idx - 1]?.id ?? null;
      }
      return {
        terminals,
        activeTerminalId,
        isTerminalVisible: terminals.length > 0 ? state.isTerminalVisible : false
      };
    });
  },

  closeTerminals: (ids: string[]) => {
    if (ids.length === 0) return;
    set((state) => {
      const terminals = state.terminals.filter((t) => !ids.includes(t.id));
      let activeTerminalId = state.activeTerminalId;
      if (activeTerminalId && ids.includes(activeTerminalId)) {
        activeTerminalId = terminals[terminals.length - 1]?.id ?? null;
      }
      return {
        terminals,
        activeTerminalId,
        isTerminalVisible: terminals.length > 0 ? state.isTerminalVisible : false,
      };
    });
  },

  closeOtherTerminals: (id: string) => {
    const { terminals, closeTerminals } = get();
    const idsToClose = terminals.filter((t) => t.id !== id).map((t) => t.id);
    closeTerminals(idsToClose);
  },

  closeTerminalsToLeft: (id: string) => {
    const { terminals, closeTerminals } = get();
    const idx = terminals.findIndex((t) => t.id === id);
    if (idx > 0) {
      const idsToClose = terminals.slice(0, idx).map((t) => t.id);
      closeTerminals(idsToClose);
    }
  },

  closeTerminalsToRight: (id: string) => {
    const { terminals, closeTerminals } = get();
    const idx = terminals.findIndex((t) => t.id === id);
    if (idx !== -1 && idx < terminals.length - 1) {
      const idsToClose = terminals.slice(idx + 1).map((t) => t.id);
      closeTerminals(idsToClose);
    }
  },

  setActiveTerminal: (id: string) => set({ activeTerminalId: id }),
  showModal: (config) => set({ modal: config }),
  closeModal: () => set({ modal: null }),
  showNotification: (message: string, type: "info" | "error" | "success" = "info") => {
    set({ notification: { message, type } });
    setTimeout(() => {
      set((state) => {
        if (state.notification?.message === message) {
          return { notification: null };
        }
        return {};
      });
    }, 3000);
  },
  clearNotification: () => set({ notification: null }),
  togglePreviewMode: (id: string) =>
    set((state) => {
      const nextTabs = state.tabs.map((tab) => {
        if (tab.id !== id) {
          return tab;
        }

        const nextIsPreviewMode = !Boolean(tab.isPreviewMode);
        return {
          ...tab,
          isPreviewMode: nextIsPreviewMode,
          isLivePreviewMode: false,
        };
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
        if (tab.id !== id) {
          return tab;
        }

        const nextIsLivePreviewMode = !Boolean(tab.isLivePreviewMode);
        return {
          ...tab,
          isPreviewMode: false,
          isLivePreviewMode: nextIsLivePreviewMode,
        };
      });

      const updatedTab = nextTabs.find((tab) => tab.id === id);
      const tabIndex = nextTabs.findIndex((tab) => tab.id === id);
      if (updatedTab && tabIndex !== -1) {
        void persistSingleTabState(updatedTab, tabIndex);
      }
      return { tabs: nextTabs };
    }),
  navigateToMarkdownHeading: (target) => set({ markdownOutlineTarget: target }),
  clearMarkdownOutlineTarget: () => set({ markdownOutlineTarget: null }),
  setRightSidebarIconOrder: (order: string[]) => {
    const sanitizedOrder = order.filter((id) => id !== "share");
    set({ rightSidebarIconOrder: sanitizedOrder });
    void saveSetting('rightSidebarIconOrder', sanitizedOrder);
  },
  setSidebarSortField: (field: 'name' | 'modified') => {
    set({ sidebarSortField: field });
    void saveSetting('sidebarSortField', field);
  },
  setSidebarSortOrder: (order: 'asc' | 'desc') => {
    set({ sidebarSortOrder: order });
    void saveSetting('sidebarSortOrder', order);
  },
  setRootPathOrder: (order: string[]) => {
    set({ rootPathOrder: order });
    void saveSetting('rootPathOrder', order);
  },
  toggleSplit: () => {
    const { isSplit } = get();
    get().setSplit(!isSplit);
  },
  setSplit: (enabled) => {
    if (enabled) {
      // 开启分屏：副窗口默认显示主窗口当前活动标签（复用同一 FileTab 引用以便内容同步）
      const { tabs, activeTabId } = get();
      const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
      set({
        isSplit: true,
        secondaryTabs: activeTab ? [activeTab] : [],
        secondaryActiveTabId: activeTab?.id ?? null,
        focusedPane: 'primary',
      });
    } else {
      // 关闭分屏：副窗口标签独立于主窗口，直接丢弃
      set({
        isSplit: false,
        secondaryTabs: [],
        secondaryActiveTabId: null,
        focusedPane: 'primary',
      });
    }
  },
  setFocusedPane: (pane) => set({ focusedPane: pane }),
  setSplitRatio: (ratio) => set({ splitRatio: Math.max(0.15, Math.min(0.85, ratio)) }),
  openTabInPane: (tab, pane) => {
    if (pane === 'primary') {
      get().openTab(tab);
      get().setFocusedPane('primary');
      return;
    }
    // 副窗口标签独立于主窗口：只加入 secondaryTabs，不影响全局 tabs
    set((s) => {
      if (s.secondaryTabs.some((t) => t.id === tab.id)) {
        return { secondaryActiveTabId: tab.id, focusedPane: 'secondary' };
      }
      return {
        secondaryTabs: [...s.secondaryTabs, tab],
        secondaryActiveTabId: tab.id,
        focusedPane: 'secondary',
      };
    });
  },
  closeTabInPane: (id, pane) => {
    if (pane === 'primary') {
      get().closeTab(id);
      return;
    }
    // 副窗口关闭只移除副窗口标签列表，不影响全局 tabs（主窗口）
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
    if (pane === 'primary') {
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
    if (pane === 'primary') {
      get().setActiveTab(id);
      get().setFocusedPane('primary');
      return;
    }
    set({ secondaryActiveTabId: id, focusedPane: 'secondary' });
  },
  toggleFolderExpanded: (path: string) => {
    const { expandedFolders } = get();
    const isExpanded = expandedFolders.includes(path);
    const newExpanded = isExpanded
      ? expandedFolders.filter(p => p !== path)
      : [...expandedFolders, path];
    set({ expandedFolders: newExpanded });
    persistExpandedFoldersState(newExpanded);
  },
  setFolderExpanded: (path: string, expanded: boolean) => {
    const { expandedFolders } = get();
    const isExpanded = expandedFolders.includes(path);
    if (isExpanded === expanded) return;

    const newExpanded = expanded
      ? [...expandedFolders, path]
      : expandedFolders.filter(p => p !== path);
    set({ expandedFolders: newExpanded });
    persistExpandedFoldersState(newExpanded);
  },
  collapseAllFolders: () => {
    set({ expandedFolders: [] });
    persistExpandedFoldersState([]);
  },
}));
