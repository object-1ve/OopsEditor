/**
 * UI slice - sidebar collapse/width, settings, modals, notifications
 */
import type { StateCreator } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  EditorState,
  ImagePreviewRequest,
  MarkdownOutlineTarget,
  SearchJumpTarget,
} from "@/store/types";
import {
  saveSetting,
  DEFAULT_MAX_OPEN_TABS,
  DEFAULT_MAX_RECENT_FILES,
  sanitizeMaxOpenTabs,
  sanitizeMaxRecentFiles,
  sanitizeRecentFiles,
} from "@/utils/settings";
import { enforceTabLimit, formatAutoClosedTabsMessage } from "@/store/services/tabEnforcer";
import { persistTabsState } from "@/utils/workspaceSession";
import { clearAutoSaveTimers, getAllAutoSaveKeys } from "@/store/services/autoSave";
import { applyCustomFont, clearCustomFont } from "@/services/customFont";

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
    | "captureProtection"
    | "setCaptureProtection"
    | "maxOpenTabs"
    | "defaultSavePath"
    | "maxRecentFolders"
    | "recentFiles"
    | "maxRecentFiles"
    | "customFontPath"
    | "customFontApplyToUi"
    | "setCustomFont"
    | "setCustomFontApplyToUi"
    | "isSettingsOpen"
    | "modal"
    | "notification"
    | "markdownOutlineTarget"
    | "navigateToMarkdownHeading"
    | "clearMarkdownOutlineTarget"
    | "searchJumpTarget"
    | "navigateToSearchMatch"
    | "clearSearchJumpTarget"
    | "toggleLeftSidebar"
    | "toggleRightSidebar"
    | "setLeftSidebarWidth"
    | "setRightSidebarWidth"
    | "setEditorWordWrap"
    | "setAutoSaveOnEdit"
    | "setMaxOpenTabs"
    | "setDefaultSavePath"
    | "setMaxRecentFolders"
    | "recordRecentFile"
    | "setRecentFiles"
    | "setMaxRecentFiles"
    | "imagePreview"
    | "openImagePreview"
    | "closeImagePreview"
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
  recentFiles: [],
  maxRecentFiles: DEFAULT_MAX_RECENT_FILES,
  customFontPath: '',
  customFontApplyToUi: false,
  searchJumpTarget: null,
  isSettingsOpen: false,
  modal: null,
  notification: null,
  markdownOutlineTarget: null,
  imagePreview: null,
  captureProtection: true,

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

  setCaptureProtection: (enabled: boolean) => {
    set({ captureProtection: enabled });
    saveSetting("captureProtection", enabled);
    void invoke("set_capture_protection", { enabled })
      .then(() => {
        get().showNotification(
          enabled ? "防截图保护已开启" : "防截图保护已关闭（需重启应用后完全生效）",
          "success",
        );
      })
      .catch((err) => {
        console.error("应用防截屏设置失败:", err);
        get().showNotification(`应用防截屏设置失败: ${String(err)}`, "error");
      });
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

  /**
   * 应用自定义字体。传空路径表示恢复内置字体栈。
   * 先确认加载成功、再落库：坏字体根本不会被持久化，重启后也不会带着它进不来。
   */
  setCustomFont: async (path, applyToUi) => {
    const nextApplyToUi = applyToUi ?? get().customFontApplyToUi;

    if (!path) {
      clearCustomFont();
      set({ customFontPath: "", customFontApplyToUi: nextApplyToUi });
      void saveSetting("customFontPath", "");
      void saveSetting("customFontApplyToUi", nextApplyToUi);
      get().showNotification("已恢复默认字体", "success");
      return;
    }

    const error = await applyCustomFont(path, nextApplyToUi);
    if (error) {
      get().showNotification(error, "error");
      return;
    }

    set({ customFontPath: path, customFontApplyToUi: nextApplyToUi });
    void saveSetting("customFontPath", path);
    void saveSetting("customFontApplyToUi", nextApplyToUi);
    get().showNotification(`已应用字体：${path.split(/[/\\]/).pop() ?? path}`, "success");
  },

  setCustomFontApplyToUi: async (applyToUi: boolean) => {
    set({ customFontApplyToUi: applyToUi });
    void saveSetting("customFontApplyToUi", applyToUi);
    // 没有选中字体时只记偏好，等选了字体再一并生效
    const { customFontPath } = get();
    if (customFontPath) await get().setCustomFont(customFontPath, applyToUi);
  },

  setMaxRecentFolders: (value: number) => {
    const clamped = Math.max(1, Math.min(100, Math.round(value)));
    set({ maxRecentFolders: clamped });
    saveSetting("maxRecentFolders", clamped);
  },

  recordRecentFile: (path: string) => {
    if (!path) return;
    const nextList = sanitizeRecentFiles([path, ...get().recentFiles], get().maxRecentFiles);
    set({ recentFiles: nextList });
    void saveSetting("recentFiles", nextList);
  },

  setRecentFiles: (files: string[]) => {
    const nextList = sanitizeRecentFiles(files, get().maxRecentFiles);
    set({ recentFiles: nextList });
    void saveSetting("recentFiles", nextList);
  },

  setMaxRecentFiles: (value: number) => {
    const clamped = sanitizeMaxRecentFiles(value);
    const trimmed = sanitizeRecentFiles(get().recentFiles, clamped);
    set({ maxRecentFiles: clamped, recentFiles: trimmed });
    void saveSetting("maxRecentFiles", clamped);
    void saveSetting("recentFiles", trimmed);
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

  navigateToSearchMatch: (target: SearchJumpTarget) => set({ searchJumpTarget: target }),

  clearSearchJumpTarget: () => set({ searchJumpTarget: null }),
  openImagePreview: (request: ImagePreviewRequest) => set({ imagePreview: request }),

  closeImagePreview: () => set({ imagePreview: null }),
});
