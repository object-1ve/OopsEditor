import { invoke } from "@tauri-apps/api/core";
import type { FileTab } from "@/types";
import type { DefaultFolder, PinnedFile } from "@/store/types";

interface DbTabRecord {
  id: number;
  file_id: string;
  name: string;
  path: string;
  language: string;
  content: string;
  view_mode: string;
  is_dirty: boolean;
  is_read_only: boolean;
  is_preview_mode: boolean;
  is_live_preview: boolean;
  size: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface DbPinnedFileRecord {
  id: number;
  name: string;
  path: string;
}

interface DbProjectRecord {
  id: number;
  name: string;
  path: string;
  description: string | null;
  tags: string | null;
  is_pinned: boolean;
  last_opened_at: string | null;
  created_at: string;
  opened_count: number;
}

type DbTabPayload = {
  file_id: string;
  name: string;
  path: string;
  language?: string;
  content?: string;
  view_mode?: string;
  is_dirty?: boolean;
  is_read_only?: boolean;
  is_preview_mode?: boolean;
  is_live_preview?: boolean;
  size?: number;
  sort_order?: number;
};

export interface WorkspaceSessionSnapshot {
  tabs: FileTab[];
  activeTabId: string | null;
  rootPaths: string[];
  defaultFolders: DefaultFolder[];
  pinnedFiles: PinnedFile[];
  expandedFolders: string[];
  pinnedFolders: string[];
}

type ReadLegacySetting = <T>(key: string) => T | null;

function toFileTab(record: DbTabRecord): FileTab {
  return {
    id: record.file_id,
    name: record.name,
    path: record.path,
    language: record.language || "plaintext",
    content: record.content || "",
    isDirty: Boolean(record.is_dirty),
    size: typeof record.size === "number" ? record.size : undefined,
    isPreviewMode: Boolean(record.is_preview_mode),
    isLivePreviewMode: Boolean(record.is_live_preview),
    viewMode: record.view_mode === "base64" ? "base64" : "text",
    isReadOnly: Boolean(record.is_read_only),
  };
}

function toDbTabPayload(tab: FileTab, sortOrder: number): DbTabPayload {
  return {
    file_id: tab.id,
    name: tab.name,
    path: tab.path,
    language: tab.language,
    content: tab.content,
    view_mode: tab.viewMode ?? "text",
    is_dirty: tab.isDirty,
    is_read_only: Boolean(tab.isReadOnly),
    is_preview_mode: Boolean(tab.isPreviewMode),
    is_live_preview: Boolean(tab.isLivePreviewMode),
    size: tab.size ?? 0,
    sort_order: sortOrder,
  };
}

function parseProjectTags(tags: string | null | undefined): string[] {
  if (!tags) {
    return [];
  }

  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function toDefaultFolder(record: DbProjectRecord): DefaultFolder {
  return {
    id: `project-${record.id}`,
    name: record.name,
    path: record.path,
  };
}

function ensureArray<T>(value: T[] | null): T[] {
  return Array.isArray(value) ? value : [];
}

function preferPrimaryArray<T>(primary: T[], fallback: T[] | null): T[] {
  if (primary.length > 0) {
    return primary;
  }
  return ensureArray(fallback);
}

async function saveSettingValue(key: string, value: unknown) {
  try {
    await invoke("set_setting", { key, value: JSON.stringify(value) });
  } catch (err) {
    console.error(`保存工作区设置 ${key} 失败:`, err);
  }
}

async function loadWorkspaceStateFromDatabase() {
  const [
    tabsResult,
    pinnedFilesResult,
    pinnedFoldersResult,
    expandedFoldersResult,
    projectsResult,
  ] = await Promise.allSettled([
    invoke<DbTabRecord[]>("get_all_tabs"),
    invoke<DbPinnedFileRecord[]>("get_pinned_files"),
    invoke<string[]>("get_pinned_folders"),
    invoke<string[]>("get_expanded_folders"),
    invoke<DbProjectRecord[]>("get_all_projects"),
  ]);

  const projects =
    projectsResult.status === "fulfilled" ? projectsResult.value : null;
  const rootProjects =
    projects?.filter((project) =>
      parseProjectTags(project.tags).includes("root"),
    ) ?? [];
  const defaultFolderProjects =
    projects?.filter((project) =>
      parseProjectTags(project.tags).includes("default-folder"),
    ) ?? [];

  return {
    tabs:
      tabsResult.status === "fulfilled" ? tabsResult.value.map(toFileTab) : [],
    pinnedFiles:
      pinnedFilesResult.status === "fulfilled"
        ? pinnedFilesResult.value.map((file) => ({
            name: file.name,
            path: file.path,
          }))
        : [],
    pinnedFolders:
      pinnedFoldersResult.status === "fulfilled" ? pinnedFoldersResult.value : [],
    expandedFolders:
      expandedFoldersResult.status === "fulfilled"
        ? expandedFoldersResult.value
        : [],
    rootPaths: rootProjects.map((project) => project.path),
    defaultFolders: defaultFolderProjects.map(toDefaultFolder),
  };
}

async function migrateLegacyWorkspaceSession(
  databaseState: Awaited<ReturnType<typeof loadWorkspaceStateFromDatabase>>,
  legacyState: Omit<WorkspaceSessionSnapshot, "activeTabId">,
) {
  const migrations: Promise<void>[] = [];

  if (databaseState.tabs.length === 0 && legacyState.tabs.length > 0) {
    migrations.push(syncTabsToDatabase(legacyState.tabs));
  }

  if (
    databaseState.pinnedFiles.length === 0 &&
    legacyState.pinnedFiles.length > 0
  ) {
    migrations.push(syncPinnedFilesToDatabase(legacyState.pinnedFiles));
  }

  if (
    databaseState.pinnedFolders.length === 0 &&
    legacyState.pinnedFolders.length > 0
  ) {
    migrations.push(syncPinnedFoldersToDatabase(legacyState.pinnedFolders));
  }

  if (
    databaseState.expandedFolders.length === 0 &&
    legacyState.expandedFolders.length > 0
  ) {
    migrations.push(syncExpandedFoldersToDatabase(legacyState.expandedFolders));
  }

  if (databaseState.rootPaths.length === 0 && legacyState.rootPaths.length > 0) {
    migrations.push(syncRootPathsToDatabase(legacyState.rootPaths));
  }

  if (
    databaseState.defaultFolders.length === 0 &&
    legacyState.defaultFolders.length > 0
  ) {
    migrations.push(syncDefaultFoldersToDatabase(legacyState.defaultFolders));
  }

  if (migrations.length === 0) {
    return;
  }

  await Promise.allSettled(migrations);
}

export async function loadWorkspaceSession(
  readLegacySetting: ReadLegacySetting,
): Promise<WorkspaceSessionSnapshot> {
  const databaseState = await loadWorkspaceStateFromDatabase();
  const legacyState = {
    tabs: ensureArray(readLegacySetting<FileTab[]>("tabs")),
    rootPaths: ensureArray(readLegacySetting<string[]>("rootPaths")),
    defaultFolders: ensureArray(
      readLegacySetting<DefaultFolder[]>("defaultFolders"),
    ),
    pinnedFiles: ensureArray(readLegacySetting<PinnedFile[]>("pinnedFiles")),
    expandedFolders: ensureArray(
      readLegacySetting<string[]>("expandedFolders"),
    ),
    pinnedFolders: ensureArray(readLegacySetting<string[]>("pinnedFolders")),
  };

  await migrateLegacyWorkspaceSession(databaseState, legacyState);

  const activeTabId = readLegacySetting<string>("activeTabId");

  return {
    tabs: preferPrimaryArray(databaseState.tabs, legacyState.tabs),
    activeTabId:
      typeof activeTabId === "string" || activeTabId === null
        ? activeTabId
        : null,
    rootPaths: preferPrimaryArray(databaseState.rootPaths, legacyState.rootPaths),
    defaultFolders: preferPrimaryArray(
      databaseState.defaultFolders,
      legacyState.defaultFolders,
    ),
    pinnedFiles: preferPrimaryArray(
      databaseState.pinnedFiles,
      legacyState.pinnedFiles,
    ),
    expandedFolders: preferPrimaryArray(
      databaseState.expandedFolders,
      legacyState.expandedFolders,
    ),
    pinnedFolders: preferPrimaryArray(
      databaseState.pinnedFolders,
      legacyState.pinnedFolders,
    ),
  };
}

export async function syncTabsToDatabase(tabs: FileTab[]) {
  try {
    const existingTabs = await invoke<DbTabRecord[]>("get_all_tabs");
    const nextIds = new Set(tabs.map((tab) => tab.id));
    const removedIds = existingTabs
      .map((tab) => tab.file_id)
      .filter((fileId) => !nextIds.has(fileId));

    await Promise.all([
      ...removedIds.map((fileId) => invoke("delete_tab", { fileId })),
      ...tabs.map((tab, index) =>
        invoke("upsert_tab", { tab: toDbTabPayload(tab, index) }),
      ),
    ]);
  } catch (err) {
    console.error("同步标签页到数据库失败:", err);
  }
}

export async function upsertTabToDatabase(tab: FileTab, sortOrder: number) {
  try {
    await invoke("upsert_tab", { tab: toDbTabPayload(tab, sortOrder) });
  } catch (err) {
    console.error(`同步标签页 ${tab.name} 失败:`, err);
  }
}

export async function syncPinnedFilesToDatabase(files: PinnedFile[]) {
  try {
    await invoke("sync_pinned_files", { files });
  } catch (err) {
    console.error("同步固定文件到数据库失败:", err);
  }
}

export async function syncPinnedFoldersToDatabase(folders: string[]) {
  try {
    await invoke("sync_pinned_folders", { folders });
  } catch (err) {
    console.error("同步固定文件夹到数据库失败:", err);
  }
}

export async function syncDefaultFoldersToDatabase(folders: DefaultFolder[]) {
  try {
    const payload = folders.map((folder) => ({
      name: folder.name,
      path: folder.path,
    }));
    await invoke("sync_default_projects", { folders: payload });
  } catch (err) {
    console.error("同步默认文件夹到数据库失败:", err);
  }
}

export async function syncExpandedFoldersToDatabase(folders: string[]) {
  try {
    await invoke("sync_expanded_folders", { folders });
  } catch (err) {
    console.error("同步展开文件夹到数据库失败:", err);
  }
}

export async function syncRootPathsToDatabase(paths: string[]) {
  try {
    await invoke("sync_root_projects", { paths });
  } catch (err) {
    console.error("同步根路径到数据库失败:", err);
  }
}

export async function persistActiveTabId(activeTabId: string | null) {
  await saveSettingValue("activeTabId", activeTabId);
}

export async function persistTabsState(
  tabs: FileTab[],
  activeTabId: string | null,
) {
  await Promise.allSettled([
    syncTabsToDatabase(tabs),
    persistActiveTabId(activeTabId),
  ]);
}

export async function persistSingleTabState(tab: FileTab, sortOrder: number) {
  await upsertTabToDatabase(tab, sortOrder);
}

export async function persistPinnedFilesState(files: PinnedFile[]) {
  await syncPinnedFilesToDatabase(files);
}

export async function persistPinnedFoldersState(folders: string[]) {
  await syncPinnedFoldersToDatabase(folders);
}

export async function persistExpandedFoldersState(folders: string[]) {
  await syncExpandedFoldersToDatabase(folders);
}

export async function persistRootPathsState(paths: string[]) {
  await syncRootPathsToDatabase(paths);
}

export async function persistDefaultFoldersState(folders: DefaultFolder[]) {
  await syncDefaultFoldersToDatabase(folders);
}
