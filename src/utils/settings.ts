import { invoke } from '@tauri-apps/api/core';
import type { FileTab } from '../types';
import type { DefaultFolder, PinnedFile } from '../store/types';
import { loadWorkspaceSession } from './workspaceSession';

export const DEFAULT_MAX_OPEN_TABS = 7;
export const MIN_OPEN_TABS_LIMIT = 1;
export const MAX_OPEN_TABS_LIMIT = 50;

export function sanitizeMaxOpenTabs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_MAX_OPEN_TABS;
  }

  return Math.min(
    MAX_OPEN_TABS_LIMIT,
    Math.max(MIN_OPEN_TABS_LIMIT, Math.round(value)),
  );
}

export interface AppSettings {
  isLeftSidebarCollapsed: boolean;
  isRightSidebarCollapsed: boolean;
  isTerminalVisible: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  terminalHeight: number;
  editorWordWrap: boolean;
  autoSaveOnEdit: boolean;
  windowSize?: { width: number; height: number };
  windowPosition?: { x: number; y: number };
  tabs: FileTab[];
  activeTabId: string | null;
  rootPaths: string[];
  defaultFolders: DefaultFolder[];
  pinnedFiles: PinnedFile[];
  expandedFolders: string[];
  pinnedFolders: string[];
  rightSidebarIconOrder?: string[];
  maxOpenTabs: number;
  sidebarSortField: 'name' | 'modified';
  sidebarSortOrder: 'asc' | 'desc';
  rootPathOrder?: string[];
  defaultSavePath: string;
  maxRecentFolders: number;
}

const DEFAULT_RIGHT_SIDEBAR_ICON_ORDER = ["info", "git", "outline", "help"] as const;

function sanitizeRightSidebarIconOrder(order?: string[]): string[] {
  if (!Array.isArray(order)) {
    return [...DEFAULT_RIGHT_SIDEBAR_ICON_ORDER];
  }

  const allowed = new Set(DEFAULT_RIGHT_SIDEBAR_ICON_ORDER);
  const sanitized = order.filter((id): id is (typeof DEFAULT_RIGHT_SIDEBAR_ICON_ORDER)[number] => allowed.has(id as (typeof DEFAULT_RIGHT_SIDEBAR_ICON_ORDER)[number]));

  if (sanitized.length === 0) {
    return [...DEFAULT_RIGHT_SIDEBAR_ICON_ORDER];
  }

  for (const id of DEFAULT_RIGHT_SIDEBAR_ICON_ORDER) {
    if (!sanitized.includes(id)) {
      sanitized.push(id);
    }
  }

  return sanitized;
}

export const defaultSettings: AppSettings = {
  isLeftSidebarCollapsed: false,
  isRightSidebarCollapsed: false,
  isTerminalVisible: false,
  leftSidebarWidth: 220,
  rightSidebarWidth: 40,
  terminalHeight: 300,
  editorWordWrap: false,
  autoSaveOnEdit: false,
  tabs: [],
  activeTabId: null,
  rootPaths: [],
  defaultFolders: [],
  pinnedFiles: [],
  expandedFolders: [],
  pinnedFolders: [],
  rightSidebarIconOrder: [...DEFAULT_RIGHT_SIDEBAR_ICON_ORDER],
  maxOpenTabs: DEFAULT_MAX_OPEN_TABS,
  sidebarSortField: 'modified',
  sidebarSortOrder: 'desc',
  defaultSavePath: '',
  maxRecentFolders: 20,
};

// ── SQLite-backed save / load ─────────────────────────────────

export async function saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
  try {
    await invoke('set_setting', { key, value: JSON.stringify(value) });
  } catch (err) {
    console.error(`保存设置 ${key} 失败:`, err);
  }
}

export async function loadSettings(): Promise<AppSettings> {
  const settings: AppSettings = { ...defaultSettings };

  try {
    const entries = await invoke<{ key: string; value: string }[]>('get_all_settings');
    const map = new Map(entries.map((e) => [e.key, e.value]));

    function get<T>(key: string): T | null {
      const raw = map.get(key);
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    }

    const savedLeftCollapsed = get<boolean>('isLeftSidebarCollapsed');
    if (typeof savedLeftCollapsed === 'boolean') settings.isLeftSidebarCollapsed = savedLeftCollapsed;

    const savedRightCollapsed = get<boolean>('isRightSidebarCollapsed');
    if (typeof savedRightCollapsed === 'boolean') settings.isRightSidebarCollapsed = savedRightCollapsed;

    const savedLeftWidth = get<number>('leftSidebarWidth');
    if (typeof savedLeftWidth === 'number') settings.leftSidebarWidth = savedLeftWidth;

    const savedRightWidth = get<number>('rightSidebarWidth');
    if (typeof savedRightWidth === 'number') settings.rightSidebarWidth = savedRightWidth;

    const savedTerminalVisible = get<boolean>('isTerminalVisible');
    if (typeof savedTerminalVisible === 'boolean') settings.isTerminalVisible = savedTerminalVisible;

    const savedTerminalHeight = get<number>('terminalHeight');
    if (typeof savedTerminalHeight === 'number') settings.terminalHeight = savedTerminalHeight;

    const savedEditorWordWrap = get<boolean>('editorWordWrap');
    if (typeof savedEditorWordWrap === 'boolean') settings.editorWordWrap = savedEditorWordWrap;

    const savedAutoSaveOnEdit = get<boolean>('autoSaveOnEdit');
    if (typeof savedAutoSaveOnEdit === 'boolean') settings.autoSaveOnEdit = savedAutoSaveOnEdit;

    const savedWindowSize = get<{ width: number; height: number }>('windowSize');
    if (savedWindowSize !== null) settings.windowSize = savedWindowSize;

    const savedWindowPosition = get<{ x: number; y: number }>('windowPosition');
    if (savedWindowPosition !== null) settings.windowPosition = savedWindowPosition;

    const savedIconOrder = get<string[]>('rightSidebarIconOrder');
    settings.rightSidebarIconOrder = sanitizeRightSidebarIconOrder(savedIconOrder ?? undefined);

    const savedMaxOpenTabs = get<number>('maxOpenTabs');
    settings.maxOpenTabs = sanitizeMaxOpenTabs(savedMaxOpenTabs);

    const savedSortField = get<'name' | 'modified'>('sidebarSortField');
    if (savedSortField === 'name' || savedSortField === 'modified') {
      settings.sidebarSortField = savedSortField;
    }

    const savedSortOrder = get<'asc' | 'desc'>('sidebarSortOrder');
    if (savedSortOrder === 'asc' || savedSortOrder === 'desc') {
      settings.sidebarSortOrder = savedSortOrder;
    }

    const savedDefaultSavePath = get<string>('defaultSavePath');
    if (typeof savedDefaultSavePath === 'string') settings.defaultSavePath = savedDefaultSavePath;

    const savedMaxRecentFolders = get<number>('maxRecentFolders');
    if (typeof savedMaxRecentFolders === 'number' && Number.isFinite(savedMaxRecentFolders)) {
      settings.maxRecentFolders = Math.max(1, Math.min(100, Math.round(savedMaxRecentFolders)));
    }

    const workspaceSession = await loadWorkspaceSession(get);
    settings.tabs = workspaceSession.tabs;
    settings.activeTabId = workspaceSession.activeTabId;
    settings.rootPaths = workspaceSession.rootPaths;
    settings.defaultFolders = workspaceSession.defaultFolders;
    settings.pinnedFiles = workspaceSession.pinnedFiles;
    settings.expandedFolders = workspaceSession.expandedFolders;
    settings.pinnedFolders = workspaceSession.pinnedFolders;

    return settings;
  } catch (err) {
    console.error('加载设置失败，使用默认值:', err);
    return settings;
  }
}
