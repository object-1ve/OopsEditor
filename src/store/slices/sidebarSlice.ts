/**
 * Sidebar slice - root paths, folders, pinned items
 */
import type { StateCreator } from "zustand";
import type { EditorState, DefaultFolder, PinnedFile } from "@/store/types";
import { normalizePath, normalizeUniquePaths } from "@/utils/path";
import { invoke } from "@tauri-apps/api/core";
import { saveSetting } from "@/utils/settings";
import {
  persistRootPathsState,
  persistDefaultFoldersState,
  persistPinnedFilesState,
  persistPinnedFoldersState,
  persistExpandedFoldersState,
} from "@/utils/workspaceSession";

export const createSidebarSlice: StateCreator<
  EditorState,
  [],
  [],
  Pick<
    EditorState,
    | "rootPaths"
    | "defaultFolders"
    | "pinnedFiles"
    | "pinnedFolders"
    | "expandedFolders"
    | "hoveredPath"
    | "sidebarSortField"
    | "sidebarSortOrder"
    | "rootPathOrder"
    | "rightSidebarIconOrder"
    | "addRootPath"
    | "removeRootPath"
    | "setDefaultFolders"
    | "updateDefaultFolder"
    | "addDefaultFolder"
    | "removeDefaultFolder"
    | "pinFolder"
    | "unpinFolder"
    | "rebasePinnedFolderPaths"
    | "removePinnedFoldersUnder"
    | "setHoveredPath"
    | "toggleFolderExpanded"
    | "setFolderExpanded"
    | "collapseAllFolders"
    | "setSidebarSortField"
    | "setSidebarSortOrder"
    | "setRootPathOrder"
    | "setRightSidebarIconOrder"
    | "recentFolders"
    | "setRecentFolders"
    | "loadRecentFolders"
  >
> = (set, get) => ({
  rootPaths: [],
  defaultFolders: [],
  pinnedFiles: [],
  pinnedFolders: [],
  expandedFolders: [],
  hoveredPath: null,
  sidebarSortField: "modified",
  sidebarSortOrder: "desc",
  rootPathOrder: [],
  recentFolders: [],
  rightSidebarIconOrder: ["info", "outline", "help"],

  setHoveredPath: (path: string | null) => set({ hoveredPath: path }),

  setRecentFolders: (folders: string[]) => set({ recentFolders: folders }),

  loadRecentFolders: async () => {
    try {
      const result = await invoke<{ path: string }[]>("get_recent_projects", { limit: 50 });
      const folders = result
        .filter((p: any) => p.last_opened_at !== null)
        .map((p: any) => p.path);
      set({ recentFolders: folders });
    } catch (err) {
      console.error("Failed to load recent folders:", err);
    }
  },

  addRootPath: (path: string) =>
    set((state) => {
      const normalizedPath = normalizePath(path);
      const newRootPaths = state.rootPaths.includes(normalizedPath)
        ? state.rootPaths
        : [...state.rootPaths, normalizedPath];
      const newRootPathOrder = state.rootPathOrder.includes(normalizedPath)
        ? state.rootPathOrder
        : [...state.rootPathOrder, normalizedPath];
      const newExpanded = state.expandedFolders.includes(normalizedPath)
        ? state.expandedFolders
        : [...state.expandedFolders, normalizedPath];

      void persistRootPathsState(newRootPaths);
      void saveSetting("rootPathOrder", newRootPathOrder);
      // Record to recent folders in DB and refresh the list
      const name = normalizedPath.split("/").filter(Boolean).pop() || normalizedPath;
      void (async () => {
        try {
          await invoke("add_project", { project: { name, path: normalizedPath, description: null, tags: null } });
        } catch {}
        try {
          await invoke("record_project_opened", { path: normalizedPath });
        } catch {}
        // Refresh recent folders list
        get().loadRecentFolders();
      })();
      persistExpandedFoldersState(newExpanded);
      return { rootPaths: newRootPaths, rootPathOrder: newRootPathOrder, expandedFolders: newExpanded };
    }),

  removeRootPath: (path: string) =>
    set((state) => {
      const newRootPaths = state.rootPaths.filter((p) => p !== path);
      const newRootPathOrder = state.rootPathOrder.filter((p) => p !== path);
      void persistRootPathsState(newRootPaths);
      void saveSetting("rootPathOrder", newRootPathOrder);
      return { rootPaths: newRootPaths, rootPathOrder: newRootPathOrder };
    }),

  setDefaultFolders: (folders: DefaultFolder[]) => {
    set({ defaultFolders: folders });
    void persistDefaultFoldersState(folders);
  },

  updateDefaultFolder: (id: string, path: string, name?: string) => {
    const folders = get().defaultFolders.map((f) =>
      f.id === id ? { ...f, path, name: name || path.split(/[/\\]/).pop() || f.name } : f,
    );
    set({ defaultFolders: folders });
    void persistDefaultFoldersState(folders);
  },

  addDefaultFolder: (name: string, path: string) => {
    const newFolder = { id: crypto.randomUUID(), name, path };
    const folders = [...get().defaultFolders, newFolder];
    set({ defaultFolders: folders });
    void persistDefaultFoldersState(folders);
  },

  removeDefaultFolder: (id: string) => {
    const folders = get().defaultFolders.filter((f) => f.id !== id);
    set({ defaultFolders: folders });
    void persistDefaultFoldersState(folders);
  },

  pinFolder: (path: string) => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    const pinnedFolders = get().pinnedFolders;
    if (pinnedFolders.includes(normalizedPath)) return;
    const nextPinnedFolders = normalizeUniquePaths([...pinnedFolders, normalizedPath]);
    set({ pinnedFolders: nextPinnedFolders });
    persistPinnedFoldersState(nextPinnedFolders);
  },

  unpinFolder: (path: string) => {
    const normalizedPath = normalizePath(path);
    const nextPinnedFolders = get().pinnedFolders.filter((item) => item !== normalizedPath);
    set({ pinnedFolders: nextPinnedFolders });
    persistPinnedFoldersState(nextPinnedFolders);
  },

  rebasePinnedFolderPaths: (oldPath: string, newPath: string) => {
    const normalizedOldPath = normalizePath(oldPath);
    const normalizedNewPath = normalizePath(newPath);
    if (!normalizedOldPath || !normalizedNewPath) return;
    const nextPinnedFolders = normalizeUniquePaths(
      get().pinnedFolders.map((item) => {
        if (item === normalizedOldPath) return normalizedNewPath;
        if (item.startsWith(`${normalizedOldPath}/`)) {
          return `${normalizedNewPath}${item.slice(normalizedOldPath.length)}`;
        }
        return item;
      }),
    );
    set({ pinnedFolders: nextPinnedFolders });
    persistPinnedFoldersState(nextPinnedFolders);
  },

  removePinnedFoldersUnder: (path: string) => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    const nextPinnedFolders = get().pinnedFolders.filter(
      (item) => item !== normalizedPath && !item.startsWith(`${normalizedPath}/`),
    );
    set({ pinnedFolders: nextPinnedFolders });
    persistPinnedFoldersState(nextPinnedFolders);
  },

  toggleFolderExpanded: (path: string) => {
    const { expandedFolders } = get();
    const isExpanded = expandedFolders.includes(path);
    const newExpanded = isExpanded
      ? expandedFolders.filter((p) => p !== path)
      : [...expandedFolders, path];
    set({ expandedFolders: newExpanded });
    persistExpandedFoldersState(newExpanded);
  },

  setFolderExpanded: (path: string, expanded: boolean) => {
    const { expandedFolders } = get();
    const isExpanded = expandedFolders.includes(path);
    if (isExpanded === expanded) return;
    const newExpanded = expanded
      ? [...expandedFolders, path]
      : expandedFolders.filter((p) => p !== path);
    set({ expandedFolders: newExpanded });
    persistExpandedFoldersState(newExpanded);
  },

  collapseAllFolders: () => {
    set({ expandedFolders: [] });
    persistExpandedFoldersState([]);
  },

  setSidebarSortField: (field: "name" | "modified") => {
    set({ sidebarSortField: field });
    void saveSetting("sidebarSortField", field);
  },

  setSidebarSortOrder: (order: "asc" | "desc") => {
    set({ sidebarSortOrder: order });
    void saveSetting("sidebarSortOrder", order);
  },

  setRootPathOrder: (order: string[]) => {
    set({ rootPathOrder: order });
    void saveSetting("rootPathOrder", order);
  },

  setRightSidebarIconOrder: (order: string[]) => {
    const sanitizedOrder = order.filter((id) => id !== "share");
    set({ rightSidebarIconOrder: sanitizedOrder });
    void saveSetting("rightSidebarIconOrder", sanitizedOrder);
  },
});
