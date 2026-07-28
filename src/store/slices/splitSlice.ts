/**
 * Split pane slice
 */
import type { StateCreator } from "zustand";
import type { EditorState, EditorPane } from "@/store/types";

export interface SplitSlice {
  isSplit: boolean;
  secondaryTabs: EditorState["secondaryTabs"];
  secondaryActiveTabId: EditorState["secondaryActiveTabId"];
  focusedPane: EditorPane;
  splitRatio: number;
  toggleSplit: () => void;
  setSplit: (enabled: boolean) => void;
  setFocusedPane: (pane: EditorPane) => void;
  setSplitRatio: (ratio: number) => void;
}

export const createSplitSlice: StateCreator<
  EditorState,
  [],
  [],
  SplitSlice
> = (set) => ({
  isSplit: false,
  secondaryTabs: [],
  secondaryActiveTabId: null,
  focusedPane: "primary",
  splitRatio: 0.5,

  toggleSplit: () => {
    // toggleSplit is overridden in the composed store to
    // work around circular reference. This is a placeholder.
  },

  setSplit: (enabled) => {
    if (enabled) {
      set({
        isSplit: true,
        secondaryTabs: [],
        secondaryActiveTabId: null,
        focusedPane: "primary",
      });
    } else {
      set({
        isSplit: false,
        secondaryTabs: [],
        secondaryActiveTabId: null,
        focusedPane: "primary",
      });
    }
  },

  setFocusedPane: (pane) => set({ focusedPane: pane }),

  setSplitRatio: (ratio) =>
    set({ splitRatio: Math.max(0.15, Math.min(0.85, ratio)) }),
});
