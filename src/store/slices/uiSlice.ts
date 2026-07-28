/**
 * UI slice - sidebar collapse/width, settings, modals, notifications
 */
import type { StateCreator } from "zustand";
import type { EditorState, MarkdownOutlineTarget } from "@/store/types";
import { saveSetting, DEFAULT_MAX_OPEN_TABS, sanitizeMaxOpenTabs } from "@/utils/settings";
import { enforceTabLimit, formatAutoClosedTabsMessage } from "@/store/services/tabEnforcer";
import { persistTabsState } from "@/utils/workspaceSession";
import { clearAutoSaveTimers, getAllAutoSaveKeys } from "@/store/services/autoSave";

export const createUiSlice: StateCreator<
  EditorState,
  [],
  [],
  Pick<
    EditorState,
    | "isLeftSidebarCollapsed"
    | "isRightSidebarCollapsed"
    | "leftSidebarWidth"
    | "rightSidebarWidth"
    | "editorWordWrap"
    | "autoSaveOnEdit"
    | "maxOpenTabs"
    | "defaultSavePath"
    | "maxRecentFolders"
    | "isSettingsOpen"
    | "modal"
    | "notification"
    | "markdownOutlineTarget"
    | "navigateToMarkdownHeading"
    | "clearMarkdownOutlineTarget"
    | "toggleLeftSidebar"
    | "toggleRightSidebar"
    | "setLeftSidebarWidth"
    | "setRightSidebarWidth"
    | "setEditorWordWrap"
    | "setAutoSaveOnEdit"
    | "setMaxOpenTabs"
    | "setDefaultSavePath"
    | "setMaxRecentFolders"
    | "openSettings"
    | "closeSettings"
    | "showModal"
    | "closeModal"
    | "showNotification"
    | "clearNotification"
  >
> = (set, get) => ({
  isLeftSidebarCollapsed: false,
  isRightSidebarCollapsed: false,
  leftSidebarWidth: 220,
  rightSidebarWidth: 40,
  editorWordWrap: false,
  autoSaveOnEdit: false,
  maxOpenTabs: DEFAULT_MAX_OPEN_TABS,
  defaultSavePath: '',
  maxRecentFolders: 20,
  isSettingsOpen: false,
  modal: null,
  notification: null,
  markdownOutlineTarget: null,

  toggleLeftSidebar: () => {
    const newValue = !get().isLeftSidebarCollapsed;
    set({ isLeftSidebarCollapsed: newValue });
    saveSetting("isLeftSidebarCollapsed", newValue);
  },

  toggleRightSidebar: () => {
    const newValue = !get().isRightSidebarCollapsed;
    set({ isRightSidebarCollapsed: newValue });
    saveSetting("isRightSidebarCollapsed", newValue);
  },

  setLeftSidebarWidth: (width: number) => {
    set({ leftSidebarWidth: width });
    saveSetting("leftSidebarWidth", width);
  },

  setRightSidebarWidth: (width: number) => {
    set({ rightSidebarWidth: width });
    saveSetting("rightSidebarWidth", width);
  },

  setEditorWordWrap: (enabled: boolean) => {
    set({ editorWordWrap: enabled });
    saveSetting("editorWordWrap", enabled);
  },

  setAutoSaveOnEdit: (enabled: boolean) => {
    set({ autoSaveOnEdit: enabled });
    saveSetting("autoSaveOnEdit", enabled);
    if (!enabled) {
      clearAutoSaveTimers(getAllAutoSaveKeys());
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
    void saveSetting("maxOpenTabs", nextMaxOpenTabs);
    persistTabsState(limitedTabsState.tabs, limitedTabsState.activeTabId);
    if (limitedTabsState.closedTabs.length > 0) {
      get().showNotification(formatAutoClosedTabsMessage(limitedTabsState.closedTabs), "info");
    }
  },

  setDefaultSavePath: (path: string) => {
    set({ defaultSavePath: path });
    saveSetting("defaultSavePath", path);
  },

  setMaxRecentFolders: (value: number) => {
    const clamped = Math.max(1, Math.min(100, Math.round(value)));
    set({ maxRecentFolders: clamped });
    saveSetting("maxRecentFolders", clamped);
  },

  openSettings: () => set({ isSettingsOpen: true }),
  closeSettings: () => set({ isSettingsOpen: false }),

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

  navigateToMarkdownHeading: (target: MarkdownOutlineTarget) =>
    set({ markdownOutlineTarget: target }),

  clearMarkdownOutlineTarget: () => set({ markdownOutlineTarget: null }),
});
