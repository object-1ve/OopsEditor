/**
 * Shared hooks for editor modes
 */
import { useState, useEffect, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { getMonacoViewState, setMonacoViewState } from "@/utils/scrollMemory";
import type { FileTab } from "@/types";

/**
 * Load preview resources (images, PDFs) via Tauri asset protocol
 */
export function usePreviewResource(
  activeTab: FileTab,
  showNotification: (message: string, type?: "info" | "error" | "success") => void,
) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;
    let objectUrl: string | null = null;
    setPreviewUrl(null);
    setPreviewError(null);

    const loadPreview = async () => {
      try {
        if (activeTab.language === "image") {
          // revision 作为查询参数避免浏览器缓存旧图片，外部变更后可即时显示新内容
          setPreviewUrl(
            convertFileSrc(activeTab.path) + `?v=${activeTab.revision ?? 0}`,
          );
          return;
        }

        if (activeTab.language === "pdf") {
          const pdfBytes = await readFile(activeTab.path);
          if (isCancelled) {
            return;
          }

          objectUrl = URL.createObjectURL(
            new Blob([pdfBytes], { type: "application/pdf" }),
          );
          setPreviewUrl(objectUrl);
          return;
        }

        setPreviewUrl(null);
      } catch {
        if (isCancelled) {
          return;
        }

        const message = activeTab.language === "pdf"
          ? "当前文件没有读取权限，或文件内容无法作为 PDF 打开"
          : "当前预览资源加载失败";
        setPreviewUrl(null);
        setPreviewError(message);
        if (activeTab.language === "pdf") {
          showNotification(`PDF 加载失败: ${message}`, "error");
        }
      }
    };

    void loadPreview();

    return () => {
      isCancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [activeTab.language, activeTab.path, activeTab.revision, showNotification]);

  return { previewUrl, previewError };
}

/**
 * Restore/save Monaco editor scroll state per tab
 */
export function useMonacoScrollMemory(tabId: string) {
  return useCallback(
    (editor: any) => {
      const saved = getMonacoViewState(tabId);
      if (saved) {
        editor.restoreViewState(saved);
      }

      const save = () => {
        try {
          const state = editor.saveViewState();
          if (state) {
            setMonacoViewState(tabId, state);
          }
        } catch {
          // editor 已 dispose 时 saveViewState 会抛错，忽略即可。
        }
      };

      const scrollDisposable = editor.onDidScrollChange(save);
      const cursorDisposable = editor.onDidChangeCursorSelection(save);

      return () => {
        scrollDisposable.dispose();
        cursorDisposable.dispose();
      };
    },
    [tabId],
  );
}
