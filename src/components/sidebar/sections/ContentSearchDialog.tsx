/**
 * ContentSearchDialog - 侧边栏搜索面板：文件内容 + 会话消息统一搜索。
 *
 * 只在点「搜索」按钮或按 Enter 时执行 —— 输入与筛选条件变化都不自动触发（全量内容搜索代价高）。
 * 筛选条件各管一个域：仅固定文件 / 文件夹 → 文件结果；会话 → 消息结果；日期范围 → 两者。
 * 空查询时展示最近打开（与 Launcher 一致）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, FileText, History, Loader2, MessageSquare, Pin } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "@/store/editor";
import { searchChatMessages, type ChatMessageMatch } from "@/services/chat";
import { formatChatDateTime } from "@/utils/chatTime";

interface ContentMatch {
  path: string;
  line: number;
  preview: string;
}

interface ContentSearchDialogProps {
  roots: string[];
  onOpenFile: (match: ContentMatch, query: string) => void;
  onOpenSession: (sessionId: number) => void;
  onClose: () => void;
}

/** 结果列表项：文件命中与会话消息命中混排（文件在前） */
type ResultItem =
  | { kind: "file"; match: ContentMatch }
  | { kind: "message"; match: ChatMessageMatch };

interface FileSearchResult {
  matches: ContentMatch[];
  truncated: boolean;
}

const EMPTY_FILE_RESULT: FileSearchResult = { matches: [], truncated: false };
const EMPTY_MESSAGE_RESULT = { matches: [] as ChatMessageMatch[], truncated: false };

export default function ContentSearchDialog({
  roots,
  onOpenFile,
  onOpenSession,
  onClose,
}: ContentSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [onlyPinned, setOnlyPinned] = useState(false);
  const [folderFilter, setFolderFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [searching, setSearching] = useState(false);
  const [fileMatches, setFileMatches] = useState<ContentMatch[]>([]);
  const [messageMatches, setMessageMatches] = useState<ChatMessageMatch[]>([]);
  const [fileTruncated, setFileTruncated] = useState(false);
  const [messageTruncated, setMessageTruncated] = useState(false);
  /** 已执行搜索对应的条件签名；与当前签名不同即结果过期（提示重新搜索） */
  const [runKey, setRunKey] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const requestIdRef = useRef(0);

  const recentFiles = useEditorStore((s) => s.recentFiles);
  const pinnedFiles = useEditorStore((s) => s.pinnedFiles);
  const chatSessions = useEditorStore((s) => s.chatSessions);
  const loadChatSessions = useEditorStore((s) => s.loadChatSessions);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 会话下拉需要会话列表：侧边栏会话区没展开过时 store 里还是空的，这里补一次
  useEffect(() => {
    if (useEditorStore.getState().chatSessions.length === 0) void loadChatSessions();
  }, [loadChatSessions]);

  const trimmed = query.trim();
  const hasQuery = trimmed.length >= 2;
  // 条件签名：任一条件变化都让已有结果过期（但不自动重搜）
  const signature = [trimmed, onlyPinned ? "pinned" : "", folderFilter, sessionFilter, dateFrom, dateTo].join("\u0000");
  const isFresh = runKey !== "" && runKey === signature;
  const filtersActive =
    onlyPinned || folderFilter !== "" || sessionFilter !== "" || dateFrom !== "" || dateTo !== "";

  const items = useMemo<ResultItem[]>(
    () => [
      ...fileMatches.map((match) => ({ kind: "file" as const, match })),
      ...messageMatches.map((match) => ({ kind: "message" as const, match })),
    ],
    [fileMatches, messageMatches],
  );

  // 空查询走最近打开(与 Launcher 一致)
  const recentItems = recentFiles.slice(0, 15);
  const showRecent = !hasQuery;

  const runSearch = useCallback(async () => {
    const keyword = query.trim();
    if (keyword.length < 2) return;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setSearching(true);
    setSelectedIndex(0);
    setRunKey("");
    setFileMatches([]);
    setMessageMatches([]);
    setFileTruncated(false);
    setMessageTruncated(false);

    // 日期输入只可能是空值或 YYYY-MM-DD，起止分别取当天首末毫秒（本地时区）
    const afterMs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const beforeMs = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;
    const pinnedPaths = pinnedFiles.map((file) => file.path);
    // 「仅固定文件」但一个都没固定 → 文件域没有可搜的（后端空 onlyPaths 表示不限，这里显式短路）
    const fileRequest =
      onlyPinned && pinnedPaths.length === 0
        ? Promise.resolve(EMPTY_FILE_RESULT)
        : invoke<FileSearchResult>("search_file_contents", {
            options: {
              // 仅固定文件时忽略文件夹范围（固定文件可能不在任何根目录下）
              roots: onlyPinned ? [] : folderFilter ? [folderFilter] : roots,
              query: keyword,
              caseSensitive: false,
              onlyPaths: onlyPinned ? pinnedPaths : [],
              modifiedAfterMs: afterMs,
              modifiedBeforeMs: beforeMs,
            },
          }).catch(() => EMPTY_FILE_RESULT);

    const messageRequest = searchChatMessages(
      keyword,
      sessionFilter ? Number(sessionFilter) : null,
      afterMs,
      beforeMs,
    ).catch(() => EMPTY_MESSAGE_RESULT);

    try {
      const [fileResult, messageResult] = await Promise.all([fileRequest, messageRequest]);
      // 期间又发起了新搜索：丢弃过期结果
      if (requestIdRef.current !== requestId) return;
      setFileMatches(fileResult.matches);
      setFileTruncated(fileResult.truncated);
      setMessageMatches(messageResult.matches);
      setMessageTruncated(messageResult.truncated);
      setRunKey(signature);
    } finally {
      if (requestIdRef.current === requestId) setSearching(false);
    }
  }, [
    query,
    signature,
    onlyPinned,
    pinnedFiles,
    folderFilter,
    roots,
    sessionFilter,
    dateFrom,
    dateTo,
  ]);

  const listLength = showRecent ? recentItems.length : isFresh ? items.length : 0;

  const openAt = (index: number) => {
    if (showRecent) {
      const path = recentItems[index];
      if (!path) return;
      onOpenFile({ path, line: 1, preview: "" }, "");
      onClose();
      return;
    }
    const item = items[index];
    if (!item) return;
    if (item.kind === "file") {
      onOpenFile(item.match, trimmed);
    } else {
      onOpenSession(item.match.session_id);
    }
    onClose();
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
      e.preventDefault();
      if (!hasQuery) return;
      // 条件改过就先重搜，结果是最新的才打开选中项
      if (isFresh) openAt(selectedIndex);
      else void runSearch();
    }
  };

  const clearFilters = () => {
    setOnlyPinned(false);
    setFolderFilter("");
    setSessionFilter("");
    setDateFrom("");
    setDateTo("");
  };

  const baseName = (p: string) => p.split(/[/\\]/).pop() || p;
  const rowClass = (index: number) =>
    `w-full text-left px-3.5 py-2.5 rounded-md cursor-pointer transition-colors ${
      index === selectedIndex ? "bg-accent/10" : "hover:bg-surface"
    }`;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex justify-center items-start pt-[10vh] select-none">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      />

      {/* Dialog */}
      <div className="relative w-full max-w-[620px] mx-4 bg-secondary border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200">
        {/* Search box:焦点反馈在整行容器上;输入框 outline 用内联盖掉全局 :focus-visible */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-border transition-colors focus-within:border-accent/60 focus-within:bg-accent/[0.04]">
          <Search size={20} className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索文件内容 / 会话消息..."
            style={{ outline: "none" }}
            className="flex-1 bg-transparent border-none text-base font-medium text-text placeholder:text-text-muted placeholder:font-normal"
          />
          {searching && <Loader2 size={16} className="shrink-0 text-text-muted animate-spin" />}
          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={!hasQuery || searching}
            title="搜索（Enter）"
            className="shrink-0 px-3 py-1 rounded-lg bg-accent hover:bg-accent-bright text-white text-xs font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            搜索
          </button>
        </div>

        {/* 筛选条件：改条件不会自动搜索，点「搜索」/回车才生效 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 border-b border-border text-xs text-text-muted">
          <button
            type="button"
            onClick={() => setOnlyPinned((value) => !value)}
            title={
              pinnedFiles.length > 0
                ? `只在 ${pinnedFiles.length} 个固定文件里搜索内容`
                : "还没有固定文件"
            }
            className={`flex items-center gap-1 px-2 py-1 rounded-md border transition-colors cursor-pointer ${
              onlyPinned
                ? "border-accent/50 bg-accent/10 text-accent"
                : "border-border hover:bg-surface hover:text-text"
            }`}
          >
            <Pin size={12} />
            仅固定文件{pinnedFiles.length > 0 ? ` (${pinnedFiles.length})` : ""}
          </button>

          <label className={`flex items-center gap-1.5 ${onlyPinned ? "opacity-50" : ""}`}>
            文件夹
            <select
              value={folderFilter}
              onChange={(e) => setFolderFilter(e.target.value)}
              disabled={onlyPinned}
              title={onlyPinned ? "「仅固定文件」时不再限文件夹" : "只在选中的文件夹里搜索文件内容"}
              style={{ outline: "none" }}
              className="max-w-[120px] px-1.5 py-1 rounded-md border border-border bg-surface text-text text-xs cursor-pointer disabled:cursor-not-allowed"
            >
              <option value="">全部</option>
              {roots.map((root) => (
                <option key={root} value={root} title={root}>
                  {baseName(root)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5">
            会话
            <select
              value={sessionFilter}
              onChange={(e) => setSessionFilter(e.target.value)}
              title="只在选中的会话里搜索消息"
              style={{ outline: "none" }}
              className="max-w-[120px] px-1.5 py-1 rounded-md border border-border bg-surface text-text text-xs cursor-pointer"
            >
              <option value="">全部</option>
              {chatSessions.map((session) => (
                <option key={session.id} value={String(session.id)} title={session.title}>
                  {session.title}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5">
            日期
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              title="起始日期（含当天）"
              style={{ outline: "none" }}
              className="px-1.5 py-1 rounded-md border border-border bg-surface text-text text-xs cursor-pointer"
            />
            <span>至</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              title="结束日期（含当天）"
              style={{ outline: "none" }}
              className="px-1.5 py-1 rounded-md border border-border bg-surface text-text text-xs cursor-pointer"
            />
          </label>

          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="px-2 py-1 rounded-md transition-colors cursor-pointer hover:bg-surface hover:text-text"
            >
              清除筛选
            </button>
          )}
        </div>

        {/* Results */}
        <div className="max-h-[400px] overflow-y-auto p-1.5">
          {showRecent ? (
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
                      className={rowClass(i)}
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
          ) : isFresh ? (
            <>
              {items.length === 0 && (
                <div className="px-4 py-6 text-sm text-text-muted text-center">未找到相关内容</div>
              )}
              {fileMatches.length > 0 && (
                <div className="px-3.5 pt-2 pb-1 text-xs font-semibold text-text-muted tracking-wide">
                  文件内容 ({fileMatches.length})
                </div>
              )}
              {fileMatches.map((m, i) => (
                <button
                  key={`${m.path}:${m.line}:${i}`}
                  ref={i === selectedIndex ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  onClick={() => openAt(i)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  title={m.path}
                  className={rowClass(i)}
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
              {messageMatches.length > 0 && (
                <div className="px-3.5 pt-3 pb-1 text-xs font-semibold text-text-muted tracking-wide">
                  会话消息 ({messageMatches.length})
                </div>
              )}
              {messageMatches.map((m, i) => {
                const index = fileMatches.length + i;
                return (
                  <button
                    key={`${m.session_id}:${m.message_id}`}
                    ref={index === selectedIndex ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                    onClick={() => openAt(index)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    title={`${m.session_title} · ${formatChatDateTime(m.created_at)}`}
                    className={rowClass(index)}
                  >
                    <div className="flex items-center gap-2">
                      <MessageSquare size={14} className="shrink-0 text-accent" />
                      <span className="truncate text-sm font-medium text-text">{m.session_title}</span>
                      <span className="shrink-0 text-xs text-text-muted">
                        {m.role === "me" ? "我" : "对方"}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-text-muted">
                        {formatChatDateTime(m.created_at)}
                      </span>
                    </div>
                    <div className="truncate pl-6 text-xs text-text-muted">{m.content}</div>
                  </button>
                );
              })}
              {(fileTruncated || messageTruncated) && (
                <div className="px-4 py-2 text-xs text-text-muted text-center">
                  结果过多已截断，请缩小搜索范围...
                </div>
              )}
            </>
          ) : searching ? (
            <div className="px-4 py-8 text-sm text-text-muted text-center">搜索中...</div>
          ) : (
            <div className="px-4 py-8 text-sm text-text-muted text-center">
              按 Enter 或点「搜索」开始搜索
            </div>
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
            <b className="font-semibold">ENTER</b> 搜索 / 打开
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
