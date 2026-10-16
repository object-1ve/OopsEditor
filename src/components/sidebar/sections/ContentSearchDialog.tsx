/**
 * ContentSearchDialog - 搜索面板：文件内容 + 会话消息统一搜索。
 *
 * 只在点「搜索」按钮或按 Enter 时执行 —— 输入与筛选条件变化都不自动触发（全量内容搜索代价高）。
 * 范围由 3 个 tab（固定文件 / 会话 / 文件夹）提供候选，点击候选即加入筛选条件、再点移出：
 * 文件与文件夹归文件域（两者并存时取并集，落在文件夹里的文件不再单列），会话归消息域；日期范围对两者都生效。
 * 空查询时不做事（不再列「最近打开」，把高度留给 3 个 tab 的候选列表）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, FileText, Loader2, MessageSquare, Pin, Folder, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEditorStore } from "@/store/editor";
import { searchChatMessages, type ChatMessageMatch } from "@/services/chat";
import { formatChatDateTime } from "@/utils/chatTime";
import {
  createFileScope,
  createFolderScope,
  createSessionScope,
  scopeBaseName,
  scopeKey,
  scopesToRequest,
  type SearchScope,
  type SearchScopeKind,
} from "./searchScope";

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
  /** 选中的搜索范围：候选点击即加入、再点移出；文件 / 会话 / 文件夹共用同一形状 */
  const [scopes, setScopes] = useState<SearchScope[]>([]);
  const [activeKind, setActiveKind] = useState<SearchScopeKind>("file");
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
  const selectedScopeKeys = useMemo(() => new Set(scopes.map(scopeKey)), [scopes]);
  // 条件签名：任一条件变化都让已有结果过期（但不自动重搜）
  const signature = [trimmed, scopes.map(scopeKey).join(","), dateFrom, dateTo].join("\u0000");
  const isFresh = runKey !== "" && runKey === signature;
  const filtersActive = scopes.length > 0 || dateFrom !== "" || dateTo !== "";

  // 3 个 tab 的候选：都是 SearchScope，点击即加入筛选条件
  const candidates: Record<SearchScopeKind, SearchScope[]> = {
    file: pinnedFiles.map((file) => createFileScope(file.path)),
    session: chatSessions.map(createSessionScope),
    folder: roots.map(createFolderScope),
  };
  const tabs: { kind: SearchScopeKind; label: string; icon: React.ReactNode; emptyHint: string }[] = [
    {
      kind: "file",
      label: "固定文件",
      icon: <Pin size={12} />,
      emptyHint: "还没有固定文件；点右侧「选择文件…」可以直接指定任意文件",
    },
    { kind: "session", label: "会话", icon: <MessageSquare size={12} />, emptyHint: "暂无会话" },
    {
      kind: "folder",
      label: "文件夹",
      icon: <Folder size={12} />,
      emptyHint: "还没有工作区文件夹；点右侧「选择文件夹…」可以指定任意目录",
    },
  ];
  const activeTabHint = tabs.find((tab) => tab.kind === activeKind)?.emptyHint ?? "";

  const items = useMemo<ResultItem[]>(
    () => [
      ...fileMatches.map((match) => ({ kind: "file" as const, match })),
      ...messageMatches.map((match) => ({ kind: "message" as const, match })),
    ],
    [fileMatches, messageMatches],
  );

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
    // 选中范围翻译成两个域的请求参数：一个范围都没选时文件域回落到全部工作区根目录
    const scopeRequest = scopesToRequest(scopes, roots);
    const fileRequest = invoke<FileSearchResult>("search_file_contents", {
      options: {
        roots: scopeRequest.roots,
        query: keyword,
        caseSensitive: false,
        onlyPaths: scopeRequest.onlyPaths,
        modifiedAfterMs: afterMs,
        modifiedBeforeMs: beforeMs,
      },
    }).catch(() => EMPTY_FILE_RESULT);

    const messageRequest = searchChatMessages(
      keyword,
      scopeRequest.sessionIds,
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
  }, [query, signature, scopes, roots, dateFrom, dateTo]);

  const listLength = isFresh ? items.length : 0;

  const openAt = (index: number) => {
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
    setScopes([]);
    setDateFrom("");
    setDateTo("");
  };

  /** 点击候选：未选中则加入范围，已选中则移出 */
  const toggleScope = (scope: SearchScope) => {
    const key = scopeKey(scope);
    setScopes((current) =>
      current.some((item) => scopeKey(item) === key)
        ? current.filter((item) => scopeKey(item) !== key)
        : [...current, scope],
    );
  };

  /** 选择器选出的范围只做加入（再次选到同一个目标不该把它取消掉） */
  const addScope = (scope: SearchScope) => {
    const key = scopeKey(scope);
    setScopes((current) => (current.some((item) => scopeKey(item) === key) ? current : [...current, scope]));
  };

  /** 「选择文件…」：固定文件之外还能直接指定任意文件作为范围 */
  const pickSearchFile = async () => {
    try {
      const selected = await open({ directory: false, multiple: false, title: "选择要搜索的文件" });
      if (typeof selected === "string") addScope(createFileScope(selected));
    } catch (err) {
      console.error("选择搜索文件失败:", err);
    }
  };

  /** 「选择文件夹…」：可选任意目录，不限于工作区根目录 */
  const pickSearchFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择要搜索的文件夹" });
      if (typeof selected === "string") addScope(createFolderScope(selected));
    } catch (err) {
      console.error("选择搜索文件夹失败:", err);
    }
  };

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

        {/* 搜索范围与时间筛选同级；改条件不会自动搜索，点「搜索」/回车才生效 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 border-b border-border text-xs text-text-muted">
          <div className="flex flex-wrap items-center gap-1.5">
            <span>搜索范围</span>
            {scopes.length === 0 ? (
              <span className="text-text-muted/85">全部（工作区根目录 + 全部会话）</span>
            ) : (
              scopes.map((scope) => (
                <span
                  key={scopeKey(scope)}
                  title={scope.detail}
                  className="flex items-center gap-1 max-w-[220px] px-2 py-1 rounded-md border border-accent/50 bg-accent/10 text-accent"
                >
                  <span className="truncate">{scope.name}</span>
                  <button
                    type="button"
                    onClick={() => toggleScope(scope)}
                    title="移出该范围"
                    className="p-0.5 rounded transition-colors cursor-pointer hover:bg-accent/15"
                  >
                    <X size={12} />
                  </button>
                </span>
              ))
            )}
          </div>

          <label className="flex items-center gap-1.5">
            时间
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

        {/* 范围候选：3 个 tab，点击候选即加入上面的搜索范围、再点移出（不自动搜索） */}
        <div className="px-4 py-2 border-b border-border text-xs">
          <div className="flex items-center gap-1">
            {tabs.map((tab) => {
              const tabCandidates = candidates[tab.kind];
              const picked = tabCandidates.filter((scope) => selectedScopeKeys.has(scopeKey(scope))).length;
              const active = tab.kind === activeKind;
              return (
                <button
                  key={tab.kind}
                  type="button"
                  onClick={() => setActiveKind(tab.kind)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                    active ? "bg-accent/10 text-accent" : "text-text-muted hover:bg-surface hover:text-text"
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                  <span className={active ? "text-accent/80" : "text-text-muted/85"}>
                    {picked > 0 ? `${picked}/${tabCandidates.length}` : tabCandidates.length}
                  </span>
                </button>
              );
            })}
            {activeKind !== "session" && (
              <button
                type="button"
                onClick={() => void (activeKind === "file" ? pickSearchFile() : pickSearchFolder())}
                className="ml-auto px-2 py-1 rounded-md border border-border text-text-muted transition-colors cursor-pointer hover:bg-surface hover:text-text"
              >
                {activeKind === "file" ? "选择文件…" : "选择文件夹…"}
              </button>
            )}
          </div>

          {/* 没有查询时结果区只剩提示，候选列表可以把这块空间铺满；有结果时收窄让位给结果 */}
          <div
            className={`mt-2 flex flex-wrap gap-1.5 overflow-y-auto ${
              hasQuery ? "max-h-[180px]" : "max-h-[420px]"
            }`}
          >
            {candidates[activeKind].length === 0 ? (
              <span className="py-1 text-text-muted/85">{activeTabHint}</span>
            ) : (
              candidates[activeKind].map((scope) => (
                <button
                  key={scopeKey(scope)}
                  type="button"
                  onClick={() => toggleScope(scope)}
                  title={scope.detail}
                  className={`max-w-[200px] truncate px-2 py-1 rounded-md border transition-colors cursor-pointer ${
                    selectedScopeKeys.has(scopeKey(scope))
                      ? "border-accent/50 bg-accent/10 text-accent"
                      : "border-border text-text-muted hover:bg-surface hover:text-text"
                  }`}
                >
                  {scope.name}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Results */}
        <div className="max-h-[380px] overflow-y-auto p-1.5">
          {isFresh ? (
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
                    <span className="truncate text-sm font-medium text-text">{scopeBaseName(m.path)}</span>
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
              先在 3 个标签里点选范围，再输入关键词按 Enter 或点「搜索」
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
