/**
 * Base64 / Hex view mode - side-by-side hex + ASCII editor
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MonacoEditor, { type EditorProps, type OnMount } from "@monaco-editor/react";
import { useMonacoScrollMemory } from "./sharedHooks";
import { decodeHexPreview, getSelectedByteRange, byteIndexToAsciiPosition, getHexOffsetLabel } from "./hexUtils";
import type { EditorModeContext, EditorModeAdapter } from "./types";

function Base64ModeView({
  activeTab,
  onChange,
  onEditorMount,
  applyTheme,
}: Pick<EditorModeContext, "activeTab" | "onChange" | "onEditorMount" | "applyTheme">) {
  const asciiEditorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const asciiDecorationIdsRef = useRef<string[]>([]);
  const [linkedByteRange, setLinkedByteRange] = useState<{
    startByte: number;
    endByte: number;
  } | null>(null);
  const base64Preview = useMemo(() => decodeHexPreview(activeTab.content), [activeTab.content]);
  const restoreHexScroll = useMonacoScrollMemory(`${activeTab.id}:base64`);
  const hexMemoryCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      hexMemoryCleanupRef.current?.();
      hexMemoryCleanupRef.current = null;
    };
  }, []);

  const syncAsciiSelectionHighlight = useCallback((nextRange: {
    startByte: number;
    endByte: number;
  } | null) => {
    const asciiEditor = asciiEditorRef.current;
    const monaco = monacoRef.current;

    if (!asciiEditor || !monaco) {
      return;
    }

    if (!nextRange) {
      asciiDecorationIdsRef.current = asciiEditor.deltaDecorations(
        asciiDecorationIdsRef.current,
        [],
      );
      return;
    }

    const start = byteIndexToAsciiPosition(nextRange.startByte);
    const end = byteIndexToAsciiPosition(nextRange.endByte);

    asciiDecorationIdsRef.current = asciiEditor.deltaDecorations(
      asciiDecorationIdsRef.current,
      [
        {
          range: new monaco.Range(
            start.lineNumber,
            start.column,
            end.lineNumber,
            end.column,
          ),
          options: {
            inlineClassName: "ascii-linked-selection",
            inlineClassNameAffectsLetterSpacing: true,
          },
        },
      ],
    );

    asciiEditor.revealLineInCenterIfOutsideViewport(start.lineNumber);
  }, []);

  useEffect(() => {
    if (base64Preview.error) {
      syncAsciiSelectionHighlight(null);
      return;
    }
    syncAsciiSelectionHighlight(linkedByteRange);
  }, [base64Preview.error, base64Preview.text, linkedByteRange, syncAsciiSelectionHighlight]);

  useEffect(() => {
    setLinkedByteRange(null);
    if (asciiEditorRef.current) {
      asciiDecorationIdsRef.current = asciiEditorRef.current.deltaDecorations(
        asciiDecorationIdsRef.current,
        [],
      );
    }
  }, [activeTab.id]);

  return (
    <div className="flex h-full bg-primary">
      <div className="flex min-w-0 flex-1 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border bg-surface/40 px-3 py-2 text-xs text-text-secondary">
          <span className="font-medium uppercase tracking-wider text-text">Hex</span>
          <span>每行 16 字节，4 字节分组</span>
        </div>
        <div className="min-h-0 flex-1">
          <MonacoEditor
            key={`${activeTab.id}:base64`}
            theme="terracotta-dark"
            language={activeTab.language}
            value={activeTab.content}
            onChange={onChange}
            onMount={(editor, monaco) => {
              applyTheme(monaco);
              monacoRef.current = monaco;
              onEditorMount(editor, monaco);
              hexMemoryCleanupRef.current?.();
              hexMemoryCleanupRef.current = restoreHexScroll(editor);
              editor.onDidChangeCursorSelection((event) => {
                const model = editor.getModel();
                const selection = event.selection;
                if (!model || !selection || selection.isEmpty()) {
                  setLinkedByteRange(null);
                  return;
                }

                const startOffset = model.getOffsetAt(selection.getStartPosition());
                const endOffset = model.getOffsetAt(selection.getEndPosition());
                setLinkedByteRange(
                  getSelectedByteRange(model.getValue(), startOffset, endOffset),
                );
              });
            }}
            options={{
              fontSize: 14,
              fontFamily: "var(--font-mono)",
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbers: getHexOffsetLabel,
              lineNumbersMinChars: 6,
              renderLineHighlight: "line",
              cursorBlinking: "smooth",
              cursorSmoothCaretAnimation: "on",
              cursorWidth: 2,
              smoothScrolling: true,
              padding: { top: 12 },
              bracketPairColorization: { enabled: true },
              automaticLayout: true,
              contextmenu: false,
              tabSize: 2,
              wordWrap: "off",
              readOnly: false,
            } satisfies EditorProps["options"]}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border bg-surface/20 px-3 py-2 text-xs text-text-secondary">
          <span className="font-medium uppercase tracking-wider text-text">Ascii</span>
          <span>
            {base64Preview.error
              ? "解析失败"
              : linkedByteRange
                ? `选中 ${(linkedByteRange.endByte - linkedByteRange.startByte).toLocaleString()} B`
                : `${base64Preview.byteLength.toLocaleString()} B`}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          {base64Preview.error ? (
            <div className="flex h-full items-center justify-center bg-deepest p-6">
              <div className="max-w-md rounded-xl border border-error/30 bg-error/5 px-4 py-3 text-sm leading-relaxed text-error">
                {base64Preview.error}
              </div>
            </div>
          ) : (
            <MonacoEditor
              key={`${activeTab.id}:decoded`}
              theme="terracotta-dark"
              language="plaintext"
              value={base64Preview.text}
              onMount={(editor, monaco) => {
                asciiEditorRef.current = editor;
                monacoRef.current = monaco;
                applyTheme(monaco);
              }}
              options={{
                fontSize: 14,
                fontFamily: "var(--font-mono)",
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                lineNumbers: getHexOffsetLabel,
                lineNumbersMinChars: 6,
                renderLineHighlight: "none",
                smoothScrolling: true,
                padding: { top: 12 },
                automaticLayout: true,
                contextmenu: false,
                tabSize: 2,
                wordWrap: "off",
                readOnly: true,
              } satisfies EditorProps["options"]}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export const base64Mode: EditorModeAdapter = {
  id: "base64",
  match: (tab) => tab.viewMode === "base64",
  render: (context) => (
    <Base64ModeView
      activeTab={context.activeTab}
      onChange={context.onChange}
      onEditorMount={context.onEditorMount}
      applyTheme={context.applyTheme}
    />
  ),
};
