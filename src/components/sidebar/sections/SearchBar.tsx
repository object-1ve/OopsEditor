/**
 * SearchBar - Sidebar file search input
 */
import { Search } from "lucide-react";
import type { RefObject } from "react";

interface SearchBarProps {
  searchInputRef: RefObject<HTMLInputElement | null>;
}

export default function SearchBar({ searchInputRef }: SearchBarProps) {
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
          placeholder="搜索文件..."
          className="w-full bg-secondary/50 border border-border rounded py-1 pl-7 pr-2 text-xs outline-none focus:border-accent/50 focus:bg-primary transition-all"
        />
      </div>
    </div>
  );
}
