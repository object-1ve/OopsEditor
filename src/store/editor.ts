import { create } from "zustand";
import type { FileTab } from "../types";
import { saveSetting, loadSettings } from "../utils/settings";
import { appDataDir } from "@tauri-apps/api/path";

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

export interface MarkdownOutlineTarget {
  tabId: string;
  headingId: string;
  line: number;
}

interface EditorState {
  tabs: FileTab[];
  activeTabId: string | null;
  openFiles: string[];
  rootPaths: string[];
  defaultFolders: DefaultFolder[];
  isLeftSidebarCollapsed: boolean;
  isRightSidebarCollapsed: boolean;
  isTerminalVisible: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  terminalHeight: number;
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
  markdownOutlineTarget: MarkdownOutlineTarget | null;
  rightSidebarIconOrder: string[];

  init: () => Promise<void>;
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
  toggleFolderExpanded: (path: string) => void;
  setFolderExpanded: (path: string, expanded: boolean) => void;
  navigateToMarkdownHeading: (target: MarkdownOutlineTarget) => void;
  clearMarkdownOutlineTarget: () => void;
  setRightSidebarIconOrder: (order: string[]) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  openFiles: [],
  rootPaths: [],
  defaultFolders: [],
  isLeftSidebarCollapsed: false,
  isRightSidebarCollapsed: false,
  isTerminalVisible: false,
  leftSidebarWidth: 220,
  rightSidebarWidth: 40,
  terminalHeight: 300,
  terminals: [],
  activeTerminalId: null,
  modal: null,
  notification: null,
  expandedFolders: [],
  pinnedFolders: [],
  markdownOutlineTarget: null,
  rightSidebarIconOrder: ["info", "outline", "help"],

  init: async () => {
    const settings = await loadSettings();

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

    set({
      isLeftSidebarCollapsed: settings.isLeftSidebarCollapsed,
      isRightSidebarCollapsed: settings.isRightSidebarCollapsed,
      isTerminalVisible: settings.isTerminalVisible || false,
      leftSidebarWidth: settings.leftSidebarWidth,
      rightSidebarWidth: settings.rightSidebarWidth,
      terminalHeight: settings.terminalHeight || 300,
      defaultFolders,
      tabs: settings.tabs || [],
      activeTabId: settings.activeTabId,
      rootPaths: settings.rootPaths || [],
      expandedFolders: settings.expandedFolders || [],
      pinnedFolders: normalizeUniquePaths(settings.pinnedFolders || []),
      openFiles: (settings.tabs || []).map(t => t.path),
      rightSidebarIconOrder: settings.rightSidebarIconOrder || ["info", "outline", "help"],
    });
  },

  openTab: (tab: FileTab) =>
    set((state) => {
      const existing = state.tabs.find((t) => t.id === tab.id);
      if (existing) {
        saveSetting('activeTabId', tab.id);
        return { activeTabId: tab.id };
      }
      const newTabs = [...state.tabs, tab];
      const newOpenFiles = [...state.openFiles, tab.path];
      saveSetting('tabs', newTabs);
      saveSetting('activeTabId', tab.id);
      return {
        tabs: newTabs,
        activeTabId: tab.id,
        openFiles: newOpenFiles,
      };
    }),

  closeTab: (id: string) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id);
      const openFiles = state.openFiles.filter((_path, i) => state.tabs[i]?.id !== id);
      let activeTabId = state.activeTabId;
      if (activeTabId === id) {
        const idx = state.tabs.findIndex((t) => t.id === id);
        activeTabId = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? null;
      }
      saveSetting('tabs', tabs);
      saveSetting('activeTabId', activeTabId);
      return { tabs, openFiles, activeTabId };
    }),

  closeTabs: (ids: string[]) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => !ids.includes(t.id));
      const openFiles = state.openFiles.filter((_path, i) => !ids.includes(state.tabs[i]?.id));
      let activeTabId = state.activeTabId;
      if (activeTabId && ids.includes(activeTabId)) {
        activeTabId = tabs[tabs.length - 1]?.id ?? null;
      }
      saveSetting('tabs', tabs);
      saveSetting('activeTabId', activeTabId);
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
    saveSetting('activeTabId', id);
  },

  updateContent: (id: string, content: string) =>
    set((state) => {
      const newTabs = state.tabs.map((t) =>
        t.id === id ? { ...t, content, isDirty: true } : t
      );
      // Note: We might not want to save content to settings on every keystroke
      // but the user wants to recover state. Let's save it for now, 
      // though usually content should be saved to file.
      // However, recover "dirty" state might be useful.
      saveSetting('tabs', newTabs);
      return { tabs: newTabs };
    }),

  markClean: (id: string) =>
    set((state) => {
      const newTabs = state.tabs.map((t) =>
        t.id === id ? { ...t, isDirty: false } : t
      );
      saveSetting('tabs', newTabs);
      return { tabs: newTabs };
    }),

  replaceTabFileLocation: (id: string, nextPath: string, nextName?: string) =>
    set((state) => {
      const nextTabs = state.tabs.map((tab) => {
        if (tab.id !== id) {
          return tab;
        }

        return {
          ...tab,
          id: nextPath,
          path: nextPath,
          name: nextName ?? nextPath.split(/[/\\]/).pop() ?? tab.name,
          isDirty: false,
        };
      });

      const nextActiveTabId = state.activeTabId === id ? nextPath : state.activeTabId;
      const nextOpenFiles = nextTabs.map((tab) => tab.path);

      saveSetting('tabs', nextTabs);
      saveSetting('activeTabId', nextActiveTabId);

      return {
        tabs: nextTabs,
        activeTabId: nextActiveTabId,
        openFiles: nextOpenFiles,
      };
    }),

  addRootPath: (path: string) =>
    set((state) => {
      const newRootPaths = state.rootPaths.includes(path)
        ? state.rootPaths
        : [...state.rootPaths, path];

      const newExpanded = state.expandedFolders.includes(path)
        ? state.expandedFolders
        : [...state.expandedFolders, path];

      saveSetting('rootPaths', newRootPaths);
      saveSetting('expandedFolders', newExpanded);
      return { rootPaths: newRootPaths, expandedFolders: newExpanded };
    }),

  removeRootPath: (path: string) =>
    set((state) => {
      const newRootPaths = state.rootPaths.filter((p) => p !== path);
      saveSetting('rootPaths', newRootPaths);
      return { rootPaths: newRootPaths };
    }),

  setDefaultFolders: (folders: DefaultFolder[]) => {
    set({ defaultFolders: folders });
    saveSetting('defaultFolders', folders);
  },

  updateDefaultFolder: (id: string, path: string, name?: string) => {
    const folders = get().defaultFolders.map(f =>
      f.id === id ? { ...f, path, name: name || path.split(/[/\\]/).pop() || f.name } : f
    );
    set({ defaultFolders: folders });
    saveSetting('defaultFolders', folders);
  },

  addDefaultFolder: (name: string, path: string) => {
    const newFolder = { id: crypto.randomUUID(), name, path };
    const folders = [...get().defaultFolders, newFolder];
    set({ defaultFolders: folders });
    saveSetting('defaultFolders', folders);
  },

  removeDefaultFolder: (id: string) => {
    const folders = get().defaultFolders.filter(f => f.id !== id);
    set({ defaultFolders: folders });
    saveSetting('defaultFolders', folders);
  },

  pinFolder: (path: string) => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;

    const pinnedFolders = get().pinnedFolders;
    if (pinnedFolders.includes(normalizedPath)) return;

    const nextPinnedFolders = normalizeUniquePaths([...pinnedFolders, normalizedPath]);
    set({ pinnedFolders: nextPinnedFolders });
    saveSetting('pinnedFolders', nextPinnedFolders);
  },

  unpinFolder: (path: string) => {
    const normalizedPath = normalizePath(path);
    const nextPinnedFolders = get().pinnedFolders.filter((item) => item !== normalizedPath);
    set({ pinnedFolders: nextPinnedFolders });
    saveSetting('pinnedFolders', nextPinnedFolders);
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
    saveSetting('pinnedFolders', nextPinnedFolders);
  },

  removePinnedFoldersUnder: (path: string) => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;

    const nextPinnedFolders = get().pinnedFolders.filter(
      (item) => item !== normalizedPath && !item.startsWith(`${normalizedPath}/`)
    );

    set({ pinnedFolders: nextPinnedFolders });
    saveSetting('pinnedFolders', nextPinnedFolders);
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
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, isPreviewMode: !t.isPreviewMode } : t
      ),
    })),
  navigateToMarkdownHeading: (target) => set({ markdownOutlineTarget: target }),
  clearMarkdownOutlineTarget: () => set({ markdownOutlineTarget: null }),
  setRightSidebarIconOrder: (order: string[]) => {
    const sanitizedOrder = order.filter((id) => id !== "share");
    set({ rightSidebarIconOrder: sanitizedOrder });
    saveSetting('rightSidebarIconOrder', sanitizedOrder);
  },
  toggleFolderExpanded: (path: string) => {
    const { expandedFolders } = get();
    const isExpanded = expandedFolders.includes(path);
    const newExpanded = isExpanded
      ? expandedFolders.filter(p => p !== path)
      : [...expandedFolders, path];
    set({ expandedFolders: newExpanded });
    saveSetting('expandedFolders', newExpanded);
  },
  setFolderExpanded: (path: string, expanded: boolean) => {
    const { expandedFolders } = get();
    const isExpanded = expandedFolders.includes(path);
    if (isExpanded === expanded) return;

    const newExpanded = expanded
      ? [...expandedFolders, path]
      : expandedFolders.filter(p => p !== path);
    set({ expandedFolders: newExpanded });
    saveSetting('expandedFolders', newExpanded);
  },
}));
