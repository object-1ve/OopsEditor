/**
 * Editor modes - resolver and exports
 *
 * Each mode is a separate file that exports an EditorModeAdapter.
 * This index combines them and provides the resolveEditorMode function.
 */
import type { FileTab } from "@/types";
import type { EditorModeAdapter } from "./types";

import { imageMode } from "./ImageMode";
import { pdfMode } from "./PdfMode";
import { wordMode } from "./WordMode";
import { sqliteMode } from "./SqliteMode";
import { markdownPreviewMode } from "./MarkdownMode";
import { base64Mode } from "./Base64Mode";
import { textMode } from "./TextMode";

export type { EditorModeContext, EditorModeAdapter, SharedContextMenuItem, OnMount } from "./types";
export { usePreviewResource, useMonacoScrollMemory } from "./sharedHooks";
export { decodeHexPreview, getHexOffsetLabel } from "./hexUtils";
export { MarkdownPreviewPane } from "./MarkdownMode";

export const editorModes: EditorModeAdapter[] = [
  imageMode,
  pdfMode,
  wordMode,
  sqliteMode,
  markdownPreviewMode,
  base64Mode,
  textMode,
];

export function resolveEditorMode(tab: FileTab) {
  return editorModes.find((mode) => mode.match(tab)) ?? textMode;
}
