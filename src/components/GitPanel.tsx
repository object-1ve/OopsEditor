import { useState, useEffect, useCallback } from "react";
import { 
    GitBranch, 
    Plus, 
    ArrowUp, 
    ArrowDown, 
    Settings, 
    RefreshCw,
    Globe,
    User
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "@/store/editor";

interface GitStatus {
    branch: string;
    staged: string[];
    unstaged: string[];
    untracked: string[];
}

interface GitUser {
    name: string | null;
    email: string | null;
}

function getParentPath(path: string): string {
    const normalized = path.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    return lastSlash === -1 ? path : normalized.slice(0, lastSlash);
}

export default function GitPanel() {
    const { rootPaths, tabs, activeTabId, showNotification } = useEditorStore();
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    const activeDirectory = activeTab?.path ? getParentPath(activeTab.path) : null;
    const initPath = rootPaths[0] ?? activeDirectory ?? null;
    const [isRepo, setIsRepo] = useState<boolean | null>(null);
    const [repoPath, setRepoPath] = useState<string | null>(null);
    const [status, setStatus] = useState<GitStatus | null>(null);
    const [gitUser, setGitUser] = useState<GitUser | null>(null);
    const [loading, setLoading] = useState(false);
    const [remoteUrl, setRemoteUrl] = useState("");
    const [showRemoteInput, setShowRemoteInput] = useState(false);

    const resolveRepoContext = useCallback(async () => {
        const candidates = [activeDirectory, ...rootPaths].filter(
            (path, index, list): path is string => Boolean(path) && list.indexOf(path) === index,
        );

        if (candidates.length === 0) {
            setRepoPath(null);
            setIsRepo(null);
            setStatus(null);
            setGitUser(null);
            setRemoteUrl("");
            return null;
        }

        try {
            for (const candidate of candidates) {
                const resolved = await invoke<string | null>("git_resolve_repo_root", { path: candidate });
                if (resolved) {
                    setRepoPath(resolved);
                    setIsRepo(true);
                    return resolved;
                }
            }

            setRepoPath(null);
            setIsRepo(false);
            setStatus(null);
            setGitUser(null);
            setRemoteUrl("");
            return null;
        } catch (err) {
            console.error("Resolve repo failed:", err);
            setRepoPath(null);
            setIsRepo(false);
            setStatus(null);
            setGitUser(null);
            setRemoteUrl("");
            return null;
        }
    }, [activeDirectory, rootPaths]);

    const fetchStatus = useCallback(async () => {
        if (!repoPath) return;
        setLoading(true);
        try {
            const result = await invoke<GitStatus>("git_get_status", { path: repoPath });
            setStatus(result);
            
            // 同时尝试获取远程地址
            const url = await invoke<string | null>("git_remote_get", { path: repoPath });
            setRemoteUrl(url ?? "");

            // 获取用户信息
            const user = await invoke<GitUser>("git_get_user", { path: repoPath });
            setGitUser(user);
        } catch (err) {
            console.error("Fetch status failed:", err);
            showNotification(String(err), "error");
        } finally {
            setLoading(false);
        }
    }, [repoPath, showNotification]);

    useEffect(() => {
        void resolveRepoContext();
    }, [resolveRepoContext]);

    useEffect(() => {
        if (!repoPath) {
            return;
        }
        void fetchStatus();
    }, [repoPath, fetchStatus]);

    useEffect(() => {
        // 监听文件系统刷新事件，自动更新 Git 状态
        const handleRefresh = (e: any) => {
            const detail = (e as CustomEvent).detail;
            if (detail && detail.path && repoPath && detail.path.replace(/\\/g, "/").startsWith(repoPath.replace(/\\/g, "/"))) {
                void fetchStatus();
            }
        };

        window.addEventListener("file-refresh" as any, handleRefresh);
        return () => window.removeEventListener("file-refresh" as any, handleRefresh);
    }, [fetchStatus, repoPath]);

    const handleInit = async () => {
        if (!initPath) return;
        try {
            await invoke("git_init", { path: initPath });
            await resolveRepoContext();
            showNotification("Git 仓库初始化成功", "success");
        } catch (err) {
            showNotification(String(err), "error");
        }
    };

    const handlePush = async () => {
        if (!repoPath) return;
        setLoading(true);
        try {
            await invoke("git_push", { path: repoPath });
            showNotification("推送成功", "success");
        } catch (err) {
            showNotification(String(err), "error");
        } finally {
            setLoading(false);
        }
    };

    const handlePull = async () => {
        if (!repoPath) return;
        setLoading(true);
        try {
            await invoke("git_pull", { path: repoPath });
            await fetchStatus();
            showNotification("拉取成功", "success");
        } catch (err) {
            showNotification(String(err), "error");
        } finally {
            setLoading(false);
        }
    };

    const handleSetRemote = async () => {
        if (!repoPath || !remoteUrl.trim()) return;
        try {
            await invoke("git_remote_add", { path: repoPath, url: remoteUrl });
            setShowRemoteInput(false);
            showNotification("远程仓库设置成功", "success");
        } catch (err) {
            showNotification(String(err), "error");
        }
    };

    if (!initPath) {
        return (
            <div className="p-4 text-sm text-text-muted text-center">
                请先打开一个文件夹
            </div>
        );
    }

    if (isRepo === false) {
        return (
            <div className="p-4 flex flex-col items-center gap-4">
                <div className="text-sm text-text-secondary text-center">
                    当前文件夹不是 Git 仓库
                </div>
                {activeDirectory && (
                    <div className="text-xs text-text-muted break-all text-center">
                        已检查当前文件目录和已打开工作区，未发现 `.git`
                    </div>
                )}
                <button
                    onClick={handleInit}
                    className="w-full py-2 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 transition-colors flex items-center justify-center gap-2"
                >
                    <Plus size={16} />
                    初始化 Git 仓库
                </button>
            </div>
        );
    }

    return (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            <div className="h-10 px-4 border-b border-border flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2 overflow-hidden">
                    <GitBranch size={16} className="text-accent shrink-0" />
                    <span className="text-sm font-medium text-text-primary truncate">
                        Git
                    </span>
                </div>
                <div className="flex items-center gap-1">
                    <button 
                        onClick={fetchStatus}
                        className={`p-1.5 hover:bg-surface rounded-md text-text-muted transition-colors ${loading ? 'animate-spin' : ''}`}
                        title="刷新"
                    >
                        <RefreshCw size={14} />
                    </button>
                    <button 
                        onClick={() => setShowRemoteInput(!showRemoteInput)}
                        className="p-1.5 hover:bg-surface rounded-md text-text-muted transition-colors"
                        title="设置远程"
                    >
                        <Settings size={14} />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <div className="space-y-3 bg-surface/30 p-3 rounded-lg border border-border">
                    <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="text-text-muted">当前分支</span>
                        <span className="text-text-primary font-medium truncate">
                            {status?.branch || "未识别"}
                        </span>
                    </div>
                    <div className="flex items-start justify-between gap-3 text-xs">
                        <span className="text-text-muted shrink-0">远程仓库</span>
                        <span className="text-text-primary font-medium break-all text-right">
                            {remoteUrl || "未配置 origin"}
                        </span>
                    </div>
                </div>

                {repoPath && (
                    <div className="text-[11px] text-text-muted break-all bg-surface/30 p-2 rounded border border-border">
                        仓库根目录: {repoPath}
                    </div>
                )}
                {showRemoteInput && (
                    <div className="space-y-2 bg-surface/30 p-3 rounded-lg border border-border">
                        <div className="flex items-center gap-2 text-xs text-text-muted uppercase tracking-wider mb-1">
                            <Globe size={12} />
                            远程仓库地址
                        </div>
                        <input
                            type="text"
                            value={remoteUrl}
                            onChange={(e) => setRemoteUrl(e.target.value)}
                            placeholder="https://github.com/..."
                            className="w-full bg-deepest border border-border rounded px-2 py-1.5 text-xs text-text-primary focus:border-accent outline-none"
                        />
                        <button
                            onClick={handleSetRemote}
                            className="w-full py-1.5 bg-accent text-white rounded text-xs font-medium hover:bg-accent/90"
                        >
                            保存远程地址
                        </button>
                    </div>
                )}

                <div className="flex gap-2">
                    <button 
                        onClick={handlePull}
                        disabled={loading}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-surface hover:bg-surface/80 text-text-primary rounded text-xs transition-colors border border-border"
                    >
                        <ArrowDown size={14} />
                        拉取
                    </button>
                    <button 
                        onClick={handlePush}
                        disabled={loading}
                        className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-surface hover:bg-surface/80 text-text-primary rounded text-xs transition-colors border border-border"
                    >
                        <ArrowUp size={14} />
                        推送
                    </button>
                </div>

                {gitUser && (gitUser.name || gitUser.email) && (
                    <div className="pt-4 border-t border-border mt-4 pb-2">
                        <div className="flex items-center gap-2 text-[11px] font-bold text-text-muted uppercase tracking-widest px-1 mb-2">
                            <User size={12} />
                            本地 Git 用户
                        </div>
                        <div className="px-2 space-y-1">
                            {gitUser.name && (
                                <div className="text-xs text-text-secondary flex justify-between">
                                    <span>姓名:</span>
                                    <span className="text-text-primary font-medium">{gitUser.name}</span>
                                </div>
                            )}
                            {gitUser.email && (
                                <div className="text-xs text-text-secondary flex justify-between">
                                    <span>邮箱:</span>
                                    <span className="text-text-primary font-medium">{gitUser.email}</span>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
