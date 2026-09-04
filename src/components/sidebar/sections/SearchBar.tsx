/**
 * SearchBar - Sidebar content search across workspace files.
 * Debounced invoke of `search_file_contents`; click a match to open the file.
 */
import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { Search, FileText, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

interface ContentMatch {
  path: string;
  line: number;
  preview: string;
}

interface SearchBarProps {
  searchInputRef: RefObject<HTMLInputElement | null>;
  roots: string[];
  onOpenFile: (path: string) => void;
}

export default function SearchBar({ searchInputRef, roots, onOpenFile }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<ContentMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setMatches([]);
      setTruncated(false);
      setSearched(false);
      setSearching(false);
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
        })
        .catch(() => {
          setMatches([]);
          setTruncated(false);
          setSearched(true);
        })
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, roots]);

  const baseName = (p: string) => p.split(/[/\\]/).pop() || p;

  return (
    <div className="px-2 py-1.5 shrink-0 border-b border-border">
      <div className="relative group">
        <Search
          size={12}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted group-focus-within:text-accent transition-colors"
        />
        <input
          ref={searchInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索文件内容..."
          className="w-full bg-secondary/50 border border-border rounded py-1 pl-7 pr-2 text-xs outline-none focus:border-accent/50 focus:bg-primary transition-all"
        />
        {searching && (
          <Loader2
            size={12}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted animate-spin"
          />
        )}
      </div>
      {query.trim().length >= 2 && (
        <div className="mt-1 max-h-64 overflow-y-auto">
          {searched && !searching && matches.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-text-muted">无匹配结果</div>
          )}
          {matches.map((m, i) => (
            <button
              key={`${m.path}:${m.line}:${i}`}
              onClick={() => onOpenFile(m.path)}
              title={m.path}
              className="w-full text-left px-2 py-1 rounded hover:bg-surface transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-1 text-xs">
                <FileText size={11} className="shrink-0 text-text-muted" />
                <span className="truncate text-text font-medium">{baseName(m.path)}</span>
                <span className="shrink-0 text-text-muted">:{m.line}</span>
              </div>
              <div className="truncate pl-4 text-xs text-text-muted font-mono">{m.preview}</div>
            </button>
          ))}
          {truncated && (
            <div className="px-2 py-1 text-xs text-text-muted">结果过多，仅显示前 {matches.length} 条</div>
          )}
        </div>
      )}
    </div>
  );
}
