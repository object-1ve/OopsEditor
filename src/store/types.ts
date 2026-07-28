import type { FileTab } from "../types";

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

/* ── Full EditorState interface including all actions ── */
export interface EditorState {
  // Data
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
  sidebarSortField: "name" | "modified";
  sidebarSortOrder: "asc" | "desc";
  rootPathOrder: string[];
  defaultSavePath: string;
  recentFolders: string[];
  maxRecentFolders: number;
  isSplit: boolean;
  secondaryTabs: FileTab[];
  secondaryActiveTabId: string | null;
  focusedPane: EditorPane;
  splitRatio: number;

  // Actions
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
  showModal: (config: {
    title: string;
    message: string;
    onConfirm: () => void;
    onCancel?: () => void;
    kind?: "warning" | "danger" | "info";
  }) => void;
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
  setSidebarSortField: (field: "name" | "modified") => void;
  setSidebarSortOrder: (order: "asc" | "desc") => void;
  setDefaultSavePath: (path: string) => void;
  setRecentFolders: (folders: string[]) => void;
  loadRecentFolders: () => Promise<void>;
  setMaxRecentFolders: (value: number) => void;
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
