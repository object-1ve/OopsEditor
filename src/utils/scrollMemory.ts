import type { editor as MonacoEditorNS } from "monaco-editor";

type MonacoViewState = MonacoEditorNS.ICodeEditorViewState | null;

const monacoStates = new Map<string, MonacoViewState>();
const previewScrollTops = new Map<string, number>();

export function setMonacoViewState(tabId: string, state: MonacoViewState) {
  monacoStates.set(tabId, state);
}

export function getMonacoViewState(tabId: string): MonacoViewState {
  return monacoStates.get(tabId) ?? null;
}

export function setPreviewScrollTop(tabId: string, scrollTop: number) {
  previewScrollTops.set(tabId, scrollTop);
}

export function getPreviewScrollTop(tabId: string): number | null {
  const value = previewScrollTops.get(tabId);
  return typeof value === "number" ? value : null;
}

export function clearScrollMemory(tabId: string) {
  monacoStates.delete(tabId);
  previewScrollTops.delete(tabId);
}
