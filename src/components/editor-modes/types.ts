/**
 * Editor mode types - shared across all editor mode components
 */
import type { ReactNode } from "react";
import type { OnMount } from "@monaco-editor/react";
import type { MarkdownOutlineTarget } from "@/store/types";
import type { FileTab } from "@/types";

export type { OnMount };

export type SharedContextMenuItem = {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  separator?: boolean;
};

export interface EditorModeContext {
  activeTab: FileTab;
  editorWordWrap: boolean;
  onChange: (value: string | undefined) => void;
  onEditorMount: OnMount;
  applyTheme: (monaco: Parameters<OnMount>[1]) => void;
  togglePreviewMode: (id: string) => void;
  toggleLivePreviewMode: (id: string) => void;
  markdownOutlineTarget: MarkdownOutlineTarget | null;
  clearMarkdownOutlineTarget: () => void;
  showNotification: (message: string, type?: "info" | "error" | "success") => void;
  /** 统一的保存入口（写盘 + 标记为已保存），供不渲染 Monaco 的模式自行绑定快捷键 */
  saveActiveTab: (id: string) => Promise<void>;
}

export interface EditorModeAdapter {
  id: string;
  match: (tab: FileTab) => boolean;
  render: (context: EditorModeContext) => ReactNode;
}
