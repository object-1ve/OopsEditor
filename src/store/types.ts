import type { FileTab } from "../types";
import type { ChatMessage, ChatSession } from "../services/chat";

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

export interface SearchJumpTarget {
  path: string;
  line: number;
  query: string;
}

/** 左侧边栏定位请求：token 递增以便重复定位同一路径时再次触发 */
export interface SidebarRevealRequest {
  path: string;
  token: number;
}

export type EditorPane = "primary" | "secondary";

/** 全屏图片查看请求：本地路径走 asset 协议，url 用于已经是可直接加载的地址 */
export interface ImagePreviewRequest {
  path: string;
  name: string;
  url?: string | null;
  /** 外部替换图片后用于破缓存 */
  revision?: number;
}

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
  sidebarRevealRequest: SidebarRevealRequest | null;
  hoveredPath: string | null;
  markdownOutlineTarget: MarkdownOutlineTarget | null;
  searchJumpTarget: SearchJumpTarget | null;
  rightSidebarIconOrder: string[];
  captureProtection: boolean;
  sidebarSortField: "name" | "modified";
  sidebarSortOrder: "asc" | "desc";
  /** 当前视图：文件（左栏文件树 + 主区编辑器）/ 会话（左栏会话列表 + 主区对话） */
  activeView: "files" | "chat";
  rootPathOrder: string[];
  defaultSavePath: string;
  recentFolders: string[];
  maxRecentFolders: number;
  recentFiles: string[];
  maxRecentFiles: number;
  /** 会话面板数据（侧边栏标签与主区视图共享） */
  chatSessions: ChatSession[];
  chatActiveSessionId: number | null;
  chatMessages: ChatMessage[];
  chatIsLoading: boolean;
  chatIsSending: boolean;
  isSplit: boolean;
  secondaryTabs: FileTab[];
  secondaryActiveTabId: string | null;
  focusedPane: EditorPane;
  splitRatio: number;
  /** 全屏图片查看请求；null 表示未打开 */
  imagePreview: ImagePreviewRequest | null;

  // Actions
  init: () => Promise<void>;
  reloadTab: (id: string, options?: { force?: boolean }) => Promise<boolean>;
  reloadTabFromDisk: (id: string) => void;
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
  setPinnedFilesOrder: (files: PinnedFile[]) => void;
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
  setCaptureProtection: (enabled: boolean) => void;
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
  expandFolders: (paths: string[]) => void;
  collapseAllFolders: () => void;
  revealPathInSidebar: (path: string) => void;
  navigateToMarkdownHeading: (target: MarkdownOutlineTarget) => void;
  clearMarkdownOutlineTarget: () => void;
  navigateToSearchMatch: (target: SearchJumpTarget) => void;
  clearSearchJumpTarget: () => void;
  setRightSidebarIconOrder: (order: string[]) => void;
  setSidebarSortField: (field: "name" | "modified") => void;
  setSidebarSortOrder: (order: "asc" | "desc") => void;
  setActiveView: (view: "files" | "chat") => void;
  loadChatSessions: () => Promise<ChatSession[]>;
  selectChatSession: (sessionId: number) => Promise<void>;
  createChatSession: () => Promise<ChatSession | null>;
  renameChatSession: (id: number, title: string) => Promise<void>;
  deleteChatSession: (id: number) => Promise<void>;
  sendChatText: (text: string) => Promise<void>;
  /** 发送文件（只记录路径） */
  sendChatFiles: (paths: string[], caption: string) => Promise<void>;
  /** 发送图片（缓存副本） */
  sendChatImages: (paths: string[], caption: string) => Promise<void>;
  /** 发送剪贴板图片 */
  sendChatClipboardImage: (base64: string, name: string, caption: string) => Promise<void>;
  editChatMessage: (id: number, content: string) => Promise<void>;
  deleteChatMessage: (id: number) => Promise<void>;
  setDefaultSavePath: (path: string) => void;
  setRecentFolders: (folders: string[]) => void;
  loadRecentFolders: () => Promise<void>;
  setMaxRecentFolders: (value: number) => void;
  recordRecentFile: (path: string) => void;
  setRecentFiles: (files: string[]) => void;
  setMaxRecentFiles: (value: number) => void;
  setRootPathOrder: (order: string[]) => void;
  toggleSplit: () => void;
  setSplit: (enabled: boolean) => void;
  setFocusedPane: (pane: EditorPane) => void;
  setSplitRatio: (ratio: number) => void;
  openImagePreview: (request: ImagePreviewRequest) => void;
  closeImagePreview: () => void;
  openTabInPane: (tab: FileTab, pane: EditorPane) => void;
  closeTabInPane: (id: string, pane: EditorPane) => void;
  closeTabsInPane: (ids: string[], pane: EditorPane) => void;
  setActiveTabInPane: (id: string, pane: EditorPane) => void;
}
