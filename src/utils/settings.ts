import { load } from '@tauri-apps/plugin-store';
import type { FileTab } from '../types';
import type { DefaultFolder } from '../store/editor';

const STORE_PATH = 'settings.json';

export interface AppSettings {
  isLeftSidebarCollapsed: boolean;
  isRightSidebarCollapsed: boolean;
  isTerminalVisible: boolean;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  terminalHeight: number;
  windowSize?: { width: number; height: number };
  windowPosition?: { x: number; y: number };
  tabs: FileTab[];
  activeTabId: string | null;
  rootPaths: string[];
  defaultFolders: DefaultFolder[];
  expandedFolders: string[];
  rightSidebarIconOrder?: string[];
}

const DEFAULT_RIGHT_SIDEBAR_ICON_ORDER = ["info", "outline", "help"] as const;

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
  tabs: [],
  activeTabId: null,
  rootPaths: [],
  defaultFolders: [],
  expandedFolders: [],
  rightSidebarIconOrder: [...DEFAULT_RIGHT_SIDEBAR_ICON_ORDER],
};

let storePromise: ReturnType<typeof load> | null = null;

async function getStore() {
  if (!storePromise) {
    storePromise = load(STORE_PATH);
  }
  return storePromise;
}

export async function saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
  const store = await getStore();
  await store.set(key, value);
  await store.save();
}

export async function loadSettings(): Promise<AppSettings> {
  const store = await getStore();
  const settings: AppSettings = { ...defaultSettings };

  const savedLeftCollapsed = await store.get<boolean>('isLeftSidebarCollapsed');
  if (typeof savedLeftCollapsed === 'boolean') settings.isLeftSidebarCollapsed = savedLeftCollapsed;

  const savedRightCollapsed = await store.get<boolean>('isRightSidebarCollapsed');
  if (typeof savedRightCollapsed === 'boolean') settings.isRightSidebarCollapsed = savedRightCollapsed;

  const savedLeftWidth = await store.get<number>('leftSidebarWidth');
  if (typeof savedLeftWidth === 'number') settings.leftSidebarWidth = savedLeftWidth;

  const savedRightWidth = await store.get<number>('rightSidebarWidth');
  if (typeof savedRightWidth === 'number') settings.rightSidebarWidth = savedRightWidth;

  const savedTerminalVisible = await store.get<boolean>('isTerminalVisible');
  if (typeof savedTerminalVisible === 'boolean') settings.isTerminalVisible = savedTerminalVisible;

  const savedTerminalHeight = await store.get<number>('terminalHeight');
  if (typeof savedTerminalHeight === 'number') settings.terminalHeight = savedTerminalHeight;

  const savedWindowSize = await store.get<{ width: number; height: number }>('windowSize');
  if (savedWindowSize !== null) settings.windowSize = savedWindowSize;

  const savedWindowPosition = await store.get<{ x: number; y: number }>('windowPosition');
  if (savedWindowPosition !== null) settings.windowPosition = savedWindowPosition;

  const savedTabs = await store.get<FileTab[]>('tabs');
  if (Array.isArray(savedTabs)) settings.tabs = savedTabs;

  const savedActiveTabId = await store.get<string>('activeTabId');
  if (typeof savedActiveTabId === 'string' || savedActiveTabId === null) settings.activeTabId = savedActiveTabId;

  const savedRootPaths = await store.get<string[]>('rootPaths');
  if (Array.isArray(savedRootPaths)) settings.rootPaths = savedRootPaths;

  const savedDefaultFolders = await store.get<DefaultFolder[]>('defaultFolders');
  if (Array.isArray(savedDefaultFolders)) settings.defaultFolders = savedDefaultFolders;

  const savedExpandedFolders = await store.get<string[]>('expandedFolders');
  if (Array.isArray(savedExpandedFolders)) settings.expandedFolders = savedExpandedFolders;

  const savedIconOrder = await store.get<string[]>('rightSidebarIconOrder');
  settings.rightSidebarIconOrder = sanitizeRightSidebarIconOrder(savedIconOrder);

  return settings;
}
