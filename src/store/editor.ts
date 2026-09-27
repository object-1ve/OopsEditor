/**
 * Composed Zustand store - combines all slices
 */
import { create } from "zustand";
import { type FileTab, isChatTab } from "@/types";
import type { ChatSession } from "@/services/chat";
import { sessionIdFromChatTabPath } from "@/components/chat/chatTab";
import { invoke } from "@tauri-apps/api/core";
import { loadSettings } from "@/utils/settings";
import { persistTabsState } from "@/utils/workspaceSession";
import { base64ToHexView, parseHexView } from "@/utils/hexView";
import { appDataDir } from "@tauri-apps/api/path";
import { applyCustomFont } from "@/services/customFont";
import { normalizePinnedFiles, normalizeUniquePaths, normalizePath } from "@/utils/path";
import { createTabsSlice } from "@/store/slices/tabsSlice";
import { createTerminalsSlice } from "@/store/slices/terminalsSlice";
import { createSidebarSlice } from "@/store/slices/sidebarSlice";
import { createUiSlice } from "@/store/slices/uiSlice";
import { createChatSlice } from "@/store/slices/chatSlice";
import { createSplitSlice } from "@/store/slices/splitSlice";
import { enforceTabLimit, formatAutoClosedTabsMessage } from "@/store/services/tabEnforcer";
import type { EditorState, DefaultFolder, EditorPane } from "@/store/types";

export type { EditorState, DefaultFolder, EditorPane } from "@/store/types";

const useEditorStore = create<EditorState>()((...a) => {
  const [set, get] = a;
  return {
    // ── Initial state from slices ──
    ...createTabsSlice(...a),
    ...createTerminalsSlice(...a),
    ...createSidebarSlice(...a),
    ...createUiSlice(...a),
    ...createChatSlice(...a),
    ...createSplitSlice(...a),

    // ── Override toggleSplit to avoid circular ref ──
    toggleSplit: () => {
      const { isSplit } = get();
      get().setSplit(!isSplit);
    },

    // ── init ──
    init: async () => {
      const settings = await loadSettings();
      const normalizedTabs = (settings.tabs || []).map((tab: FileTab) => {
        if (tab.viewMode !== "base64") return tab;
        const parsedHex = parseHexView(tab.content);
        const nextContent = parsedHex.error ? base64ToHexView(tab.content) : tab.content;
        return { ...tab, content: nextContent, isReadOnly: false };
      });

      // 持久化的会话标签（chat:<sessionId>）只存了伪路径，标题从会话库回填，
      // 会话已删除的标签直接丢弃
      const chatSessions = await invoke<ChatSession[]>("get_chat_sessions").catch((err) => {
        console.error("恢复会话标签失败:", err);
        return [] as ChatSession[];
      });
      const sessionTitles = new Map(chatSessions.map((s) => [s.id, s.title]));
      const rehydratedTabs = normalizedTabs.filter(
        (tab) => !isChatTab(tab) || sessionTitles.has(sessionIdFromChatTabPath(tab.path) ?? NaN),
      );
      for (const tab of rehydratedTabs) {
        if (!isChatTab(tab)) continue;
        const sessionId = sessionIdFromChatTabPath(tab.path);
        if (sessionId === null) continue;
        tab.name = sessionTitles.get(sessionId) ?? tab.name;
      }

      let defaultFolders = settings.defaultFolders;
      if (!defaultFolders || defaultFolders.length === 0) {
        try {
          const path = await appDataDir();
          const name = path.split(/[/\\]/).filter(Boolean).pop() || "AppData";
          defaultFolders = [{ id: "default-appdata", name, path }];
        } catch (err) {
          console.error("Failed to get app data dir:", err);
          defaultFolders = [
            { id: "default-src", name: "src", path: "d:/Desktop/oops_try/OopsEditor/src" },
          ];
        }
      }

      const limitedTabsState = enforceTabLimit(
        rehydratedTabs,
        settings.activeTabId,
        settings.maxOpenTabs,
      );

      const rightSidebarIconOrder = (settings.rightSidebarIconOrder || [
        "chat",
        "info",
        "outline",
        "help",
      ]).filter((id) => id !== "git");

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
        defaultSavePath: settings.defaultSavePath,
        captureProtection: settings.captureProtection,
        maxRecentFolders: settings.maxRecentFolders,
        recentFiles: settings.recentFiles,
        maxRecentFiles: settings.maxRecentFiles,
        rootPathOrder: settings.rootPathOrder || settings.rootPaths || [],
        customFontPath: settings.customFontPath,
        customFontApplyToUi: settings.customFontApplyToUi,
      });

      // 自定义字体是运行期加载的 FontFace，重启后进程内状态清空，必须重新应用一次（失败不阻塞启动）
      if (settings.customFontPath) {
        void applyCustomFont(settings.customFontPath, settings.customFontApplyToUi);
      }

      // Record existing rootPaths to DB FIRST, then load recent folders
      const savedRootPaths = settings.rootPaths || [];
      const recordPromises = savedRootPaths.map(async (path) => {
        const normalizedPath = normalizePath(path);
        const name = normalizedPath.split("/").filter(Boolean).pop() || normalizedPath;
        try {
          await invoke("add_project", { project: { name, path: normalizedPath, description: null, tags: null } });
        } catch {
          // Project may already exist, that's fine
        }
        try {
          await invoke("record_project_opened", { path: normalizedPath });
        } catch {}
      });
      await Promise.all(recordPromises);

      // Load recent folders from DB (after recording)
      await get().loadRecentFolders();

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
  };
});

export { useEditorStore };
