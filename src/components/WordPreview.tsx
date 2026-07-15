import { useEffect, useMemo, useRef, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { renderAsync } from "docx-preview";

interface WordPreviewProps {
  name: string;
  path: string;
  showNotification: (message: string, type?: "info" | "error" | "success") => void;
}

const OPEN_XML_WORD_EXTENSIONS = new Set(["docx", "docm", "dotx", "dotm"]);

function getWordExtension(path: string) {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

export default function WordPreview({
  name,
  path,
  showNotification,
}: WordPreviewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const extension = useMemo(() => getWordExtension(path), [path]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bodyContainer = bodyRef.current;
    const styleContainer = styleRef.current;

    if (!bodyContainer || !styleContainer) {
      return;
    }

    bodyContainer.innerHTML = "";
    styleContainer.innerHTML = "";
    setIsLoading(true);
    setError(null);

    if (extension === "doc") {
      let isCancelled = false;
      setIsLoading(true);
      setError(null);

      const loadConverted = async () => {
        try {
          const docxPath = await invoke<string>("convert_doc_to_docx", { path });
          if (isCancelled || !bodyContainer || !styleContainer) {
            return;
          }

          const fileBytes = await readFile(docxPath);
          if (isCancelled) {
            return;
          }

          bodyContainer.innerHTML = "";
          styleContainer.innerHTML = "";

          await renderAsync(fileBytes, bodyContainer, styleContainer, {
            className: "word-document",
            inWrapper: true,
            useBase64URL: true,
            renderHeaders: true,
            renderFooters: true,
            renderFootnotes: true,
            renderEndnotes: true,
          });

          if (isCancelled) {
            return;
          }

          setIsLoading(false);
        } catch (err) {
          if (isCancelled) {
            return;
          }

          const detail = err instanceof Error ? err.message : String(err);
          const message = detail || "当前 .doc 文件无法预览，请确认已安装 Microsoft Word。";
          bodyContainer.innerHTML = "";
          styleContainer.innerHTML = "";
          setIsLoading(false);
          setError(message);
          showNotification(`Word 加载失败: ${message}`, "error");
        }
      };

      void loadConverted();

      return () => {
        isCancelled = true;
        bodyContainer.innerHTML = "";
        styleContainer.innerHTML = "";
      };
    }

    if (!OPEN_XML_WORD_EXTENSIONS.has(extension)) {
      setIsLoading(false);
      setError("当前 Word 文件格式暂不支持预览。");
      return;
    }

    let isCancelled = false;

    const loadPreview = async () => {
      try {
        const fileBytes = await readFile(path);
        if (isCancelled) {
          return;
        }

        bodyContainer.innerHTML = "";
        styleContainer.innerHTML = "";

        await renderAsync(fileBytes, bodyContainer, styleContainer, {
          className: "word-document",
          inWrapper: true,
          useBase64URL: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
        });

        if (isCancelled) {
          return;
        }

        setIsLoading(false);
      } catch {
        if (isCancelled) {
          return;
        }

        const message = "当前文件没有读取权限，或文件内容无法作为 Word 文档打开。";
        bodyContainer.innerHTML = "";
        styleContainer.innerHTML = "";
        setIsLoading(false);
        setError(message);
        showNotification(`Word 加载失败: ${message}`, "error");
      }
    };

    void loadPreview();

    return () => {
      isCancelled = true;
      bodyContainer.innerHTML = "";
      styleContainer.innerHTML = "";
    };
  }, [extension, path, showNotification]);

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-deepest">
      <div className="flex items-center justify-between border-b border-border bg-surface/40 px-4 py-2 text-xs text-text-secondary">
        <span className="truncate font-medium text-text-primary">{name}</span>
        <span className="uppercase tracking-wider">{extension || "word"}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {error ? (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-lg rounded-2xl border border-border bg-primary px-6 py-5 text-center shadow-sm">
              <div className="text-base font-semibold text-text-primary">无法预览 Word 文件</div>
              <div className="mt-2 text-sm leading-6 text-text-secondary">{error}</div>
            </div>
          </div>
        ) : (
          <div className="relative min-h-full">
            {isLoading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl border border-border/60 bg-primary/85 backdrop-blur-sm">
                <div className="text-sm text-text-secondary">正在加载 Word 预览...</div>
              </div>
            )}
            <div ref={styleRef} className="word-preview-styles" aria-hidden="true" />
            <div
              ref={bodyRef}
              className="word-preview-shell min-h-full rounded-2xl border border-border bg-primary shadow-sm"
            />
          </div>
        )}
      </div>
    </div>
  );
}
