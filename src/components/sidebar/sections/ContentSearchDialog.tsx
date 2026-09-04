/**
 * ContentSearchDialog - Command-palette style content search across workspace files.
 * Opens as a centered modal (Launcher SearchOverlay pattern): big input, results list,
 * keyboard nav (↑↓/Enter/ESC), recent files when query is empty.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, FileText, History, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "@/store/editor";

interface ContentMatch {
  path: string;
  line: number;
  preview: string;
}

interface ContentSearchDialogProps {
  roots: string[];
  onOpenFile: (match: ContentMatch, query: string) => void;
  onClose: () => void;
}

export default function ContentSearchDialog({ roots, onOpenFile, onClose }: ContentSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<ContentMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const recentFiles = useEditorStore((s) => s.recentFiles);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setMatches([]);
      setTruncated(false);
      setSearched(false);
      setSearching(false);
      setSelectedIndex(0);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      invoke<{ matches: ContentMatch[]; truncated: boolean }>("search_file_contents", {
        roots,
        query: q,
        caseSensitive: false,
      })
        .then((res) => {
          setMatches(res.matches);
          setTruncated(res.truncated);
          setSearched(true);
          setSelectedIndex(0);
        })
        .catch(() => {
          setMatches([]);
          setTruncated(false);
          setSearched(true);
          setSelectedIndex(0);
        })
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, roots]);

  const hasQuery = query.trim().length >= 2;
  // 有查询走搜索结果,空查询走最近打开(与 Launcher 一致)
  const recentItems = recentFiles.slice(0, 15);
  const listLength = hasQuery ? matches.length : recentItems.length;
  const openAt = (index: number) => {
    if (hasQuery) {
      const m = matches[index];
      if (m) {
        onOpenFile(m, query.trim());
        onClose();
      }
    } else {
      const p = recentItems[index];
      if (p) {
        onOpenFile({ path: p, line: 1, preview: "" }, "");
        onClose();
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => (listLength > 0 ? (i + 1) % listLength : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => (listLength > 0 ? (i - 1 + listLength) % listLength : 0));
    } else if (e.key === "Enter") {
      openAt(selectedIndex);
    }
  };

  const baseName = (p: string) => p.split(/[/\\]/).pop() || p;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex justify-center items-start pt-[12vh] select-none">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      />

      {/* Dialog */}
      <div className="relative w-full max-w-[560px] mx-4 bg-secondary border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
        {/* Search box:焦点反馈在整行容器上;输入框 outline 用内联盖掉全局 :focus-visible */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border transition-colors focus-within:border-accent/60 focus-within:bg-accent/[0.04]">
          <Search size={20} className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索文件内容..."
            style={{ outline: "none" }}
            className="flex-1 bg-transparent border-none text-base font-medium text-text placeholder:text-text-muted placeholder:font-normal"
          />
          {searching && <Loader2 size={16} className="shrink-0 text-text-muted animate-spin" />}
        </div>

        {/* Results */}
        <div className="max-h-[420px] overflow-y-auto p-1.5">
          {hasQuery ? (
            <>
              {searched && !searching && matches.length === 0 && (
                <div className="px-4 py-6 text-sm text-text-muted text-center">未找到相关内容</div>
              )}
              {matches.map((m, i) => (
                <button
                  key={`${m.path}:${m.line}:${i}`}
                  ref={i === selectedIndex ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  onClick={() => openAt(i)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  title={m.path}
                  className={`w-full text-left px-3.5 py-2.5 rounded-md cursor-pointer transition-colors ${
                    i === selectedIndex ? "bg-accent/10" : "hover:bg-surface"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <FileText size={14} className="shrink-0 text-text-muted" />
                    <span className="truncate text-sm font-medium text-text">{baseName(m.path)}</span>
                    <span className="shrink-0 text-xs text-text-muted">:{m.line}</span>
                  </div>
                  <div className="truncate pl-6 text-xs text-text-muted font-mono">{m.preview}</div>
                  <div className="truncate pl-6 text-xs text-text-muted/70">{m.path}</div>
                </button>
              ))}
              {truncated && (
                <div className="px-4 py-2 text-xs text-text-muted text-center">
                  结果过多，仅显示前 {matches.length} 条，请缩小搜索范围...
                </div>
              )}
            </>
          ) : (
            <>
              {recentItems.length > 0 ? (
                <>
                  <div className="px-3.5 pt-2 pb-1 text-xs font-semibold text-text-muted tracking-wide">
                    最近打开
                  </div>
                  {recentItems.map((p, i) => (
                    <button
                      key={p}
                      ref={i === selectedIndex ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                      onClick={() => openAt(i)}
                      onMouseEnter={() => setSelectedIndex(i)}
                      title={p}
                      className={`w-full text-left px-3.5 py-2.5 rounded-md cursor-pointer transition-colors ${
                        i === selectedIndex ? "bg-accent/10" : "hover:bg-surface"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <History size={14} className="shrink-0 text-text-muted" />
                        <span className="truncate text-sm font-medium text-text">{baseName(p)}</span>
                      </div>
                      <div className="truncate pl-6 text-xs text-text-muted/70">{p}</div>
                    </button>
                  ))}
                </>
              ) : (
                <div className="px-4 py-6 text-sm text-text-muted text-center">暂无最近打开的文件</div>
              )}
            </>
          )}
        </div>

        {/* Hints */}
        <div className="flex items-center gap-4 px-4 py-2.5 border-t border-border text-xs text-text-muted">
          <span>
            <b className="font-semibold">ESC</b> 退出
          </span>
          <span>
            <b className="font-semibold">↑↓</b> 选择
          </span>
          <span>
            <b className="font-semibold">ENTER</b> 打开
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
