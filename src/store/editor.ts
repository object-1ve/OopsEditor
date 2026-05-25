import { create } from "zustand";
import type { FileTab } from "../types";
import { saveSetting, loadSettings } from "../utils/settings";

interface EditorState {
  tabs: FileTab[];
  activeTabId: string | null;
  openFiles: string[];
  rootPath: string | null;
  isLeftSidebarCollapsed: boolean;
  isRightSidebarCollapsed: boolean;
  isTerminalVisible: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  terminalHeight: number;
  terminalPath: string | null;
  notification: { message: string; type: "info" | "error" | "success" } | null;

  init: () => Promise<void>;
  openTab: (tab: FileTab) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateContent: (id: string, content: string) => void;
  markClean: (id: string) => void;
  setRootPath: (path: string | null) => void;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  toggleTerminal: () => void;
  setTerminalVisible: (visible: boolean) => void;
  setLeftSidebarWidth: (width: number) => void;
  setRightSidebarWidth: (width: number) => void;
  setTerminalHeight: (height: number) => void;
  setTerminalPath: (path: string | null) => void;
  showNotification: (message: string, type?: "info" | "error" | "success") => void;
  clearNotification: () => void;
  togglePreviewMode: (id: string) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  openFiles: [],
  rootPath: null,
  isLeftSidebarCollapsed: false,
  isRightSidebarCollapsed: false,
  isTerminalVisible: false,
  leftSidebarWidth: 260,
  rightSidebarWidth: 48,
  terminalHeight: 300,
  terminalPath: null,
  notification: null,

  init: async () => {
    const settings = await loadSettings();
    set({
      isLeftSidebarCollapsed: settings.isLeftSidebarCollapsed,
      isRightSidebarCollapsed: settings.isRightSidebarCollapsed,
      isTerminalVisible: settings.isTerminalVisible || false,
      leftSidebarWidth: settings.leftSidebarWidth,
      rightSidebarWidth: settings.rightSidebarWidth,
      terminalHeight: settings.terminalHeight || 300,
    });
  },

  openTab: (tab: FileTab) =>
    set((state) => {
      const existing = state.tabs.find((t) => t.id === tab.id);
      if (existing) {
        return { activeTabId: tab.id };
      }
      return {
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        openFiles: [...state.openFiles, tab.path],
      };
    }),

  closeTab: (id: string) =>
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id);
      const openFiles = state.openFiles.filter((_, i) => state.tabs[i]?.id !== id);
      let activeTabId = state.activeTabId;
      if (activeTabId === id) {
        const idx = state.tabs.findIndex((t) => t.id === id);
        activeTabId = tabs[idx]?.id ?? tabs[idx - 1]?.id ?? null;
      }
      return { tabs, openFiles, activeTabId };
    }),

  setActiveTab: (id: string) => set({ activeTabId: id }),

  updateContent: (id: string, content: string) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, content, isDirty: true } : t
      ),
    })),

  markClean: (id: string) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, isDirty: false } : t
      ),
    })),

  setRootPath: (path: string | null) => set({ rootPath: path }),

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
    const newValue = !get().isTerminalVisible;
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
  setTerminalPath: (path: string | null) => set({ terminalPath: path }),

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
}));
