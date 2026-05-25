import { load } from '@tauri-apps/plugin-store';

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
}

export const defaultSettings: AppSettings = {
  isLeftSidebarCollapsed: false,
  isRightSidebarCollapsed: false,
  isTerminalVisible: false,
  leftSidebarWidth: 260,
  rightSidebarWidth: 48,
  terminalHeight: 300,
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

  return settings;
}
