/**
 * Terminals slice - terminal instance management
 */
import type { StateCreator } from "zustand";
import type { EditorState, TerminalInstance } from "@/store/types";
import { saveSetting } from "@/utils/settings";
import { persistDefaultFoldersState } from "@/utils/workspaceSession";

export const createTerminalsSlice: StateCreator<
  EditorState,
  [],
  [],
  Pick<
    EditorState,
    | "terminals"
    | "activeTerminalId"
    | "isTerminalVisible"
    | "terminalHeight"
    | "addTerminal"
    | "removeTerminal"
    | "closeTerminals"
    | "closeOtherTerminals"
    | "closeTerminalsToLeft"
    | "closeTerminalsToRight"
    | "setActiveTerminal"
    | "toggleTerminal"
    | "setTerminalVisible"
    | "setTerminalHeight"
  >
> = (set, get) => ({
  terminals: [],
  activeTerminalId: null,
  isTerminalVisible: false,
  terminalHeight: 300,

  addTerminal: (path: string | null = null) => {
    const id = crypto.randomUUID();
    const newTerminal: TerminalInstance = {
      id,
      name: `终端 ${get().terminals.length + 1}`,
      path: path || get().rootPaths[0] || null,
    };
    set((state) => ({
      terminals: [...state.terminals, newTerminal],
      activeTerminalId: id,
      isTerminalVisible: true,
    }));
    saveSetting("isTerminalVisible", true);
  },

  removeTerminal: (id: string) => {
    set((state) => {
      const terminals = state.terminals.filter((t) => t.id !== id);
      let activeTerminalId = state.activeTerminalId;
      if (activeTerminalId === id) {
        const idx = state.terminals.findIndex((t) => t.id === id);
        activeTerminalId = terminals[idx]?.id ?? terminals[idx - 1]?.id ?? null;
      }
      return {
        terminals,
        activeTerminalId,
        isTerminalVisible: terminals.length > 0 ? state.isTerminalVisible : false,
      };
    });
  },

  closeTerminals: (ids: string[]) => {
    if (ids.length === 0) return;
    set((state) => {
      const terminals = state.terminals.filter((t) => !ids.includes(t.id));
      let activeTerminalId = state.activeTerminalId;
      if (activeTerminalId && ids.includes(activeTerminalId)) {
        activeTerminalId = terminals[terminals.length - 1]?.id ?? null;
      }
      return {
        terminals,
        activeTerminalId,
        isTerminalVisible: terminals.length > 0 ? state.isTerminalVisible : false,
      };
    });
  },

  closeOtherTerminals: (id: string) => {
    const { terminals, closeTerminals } = get();
    const idsToClose = terminals.filter((t) => t.id !== id).map((t) => t.id);
    closeTerminals(idsToClose);
  },

  closeTerminalsToLeft: (id: string) => {
    const { terminals, closeTerminals } = get();
    const idx = terminals.findIndex((t) => t.id === id);
    if (idx > 0) {
      const idsToClose = terminals.slice(0, idx).map((t) => t.id);
      closeTerminals(idsToClose);
    }
  },

  closeTerminalsToRight: (id: string) => {
    const { terminals, closeTerminals } = get();
    const idx = terminals.findIndex((t) => t.id === id);
    if (idx !== -1 && idx < terminals.length - 1) {
      const idsToClose = terminals.slice(idx + 1).map((t) => t.id);
      closeTerminals(idsToClose);
    }
  },

  setActiveTerminal: (id: string) => set({ activeTerminalId: id }),

  toggleTerminal: () => {
    const { isTerminalVisible, terminals, addTerminal } = get();
    const newValue = !isTerminalVisible;
    if (newValue && terminals.length === 0) {
      addTerminal();
    }
    set({ isTerminalVisible: newValue });
    saveSetting("isTerminalVisible", newValue);
  },

  setTerminalVisible: (visible: boolean) => {
    set({ isTerminalVisible: visible });
    saveSetting("isTerminalVisible", visible);
  },

  setTerminalHeight: (height: number) => {
    set({ terminalHeight: height });
    saveSetting("terminalHeight", height);
  },
});
