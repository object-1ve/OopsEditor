//! 会话面板数据层：会话 / 消息以 JSONL 事件日志存储，聊天图片附件落盘。
//!
//! 存储策略与 omp / Claude Code 一致：**私有存储 + 派生索引 + 容错解析 + 追加写**。
//!
//! - 私有存储：每个会话一个 `<时间戳>_<随机后缀>.jsonl`，放在应用数据目录
//!   `chat-sessions/` 下，不写进用户工作区；文件名只是 key，会话 id 存内容里。
//! - 追加写：每行一条事件（`session` / `title` / `message` / `message-edit` /
//!   `message-favorite` / `message-delete`），变更只 append，不重写整个文件；
//!   读取时按顺序 fold 出当前状态，崩溃最多丢最后一行。
//! - 容错解析：坏行、未知类型、无有效记录的杂物文件全部跳过，一个坏文件不会
//!   让整个会话列表或搜索失败；旧版「header + 裸消息行」格式仍可读。
//! - 派生索引：`chat_index` 表只缓存 (mtime,size) 命中的会话元数据，源数据永远
//!   是文件本身；索引丢失/损坏只会变慢，结果不变。
//!
//! - 消息文本可编辑，编辑后 `edited = true` 且 `updated_at` 前进，`created_at` 保持不变；
//! - 发送的**文件**只记录其本地路径（不复制、不读内容），始终指回原文件；
//!   只有**图片**需要落盘一份副本——webview 要通过 asset 协议渲染缩略图，
//!   而原始文件可能随时被移动/删除，缓存一份才能保证历史消息里的图仍在。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Local;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 聊天图片目录名（位于应用数据目录下）
const CHAT_ATTACHMENT_DIR: &str = "chat-attachments";
/// 重命名时留空导致的兜底标题（新建会话走时间戳，见 `new_session_title`）
const DEFAULT_SESSION_TITLE: &str = "新会话";
/// 文件名中保留的哈希字符数（与 attachment.rs 对齐）
const HASH_LEN: usize = 16;
/// 可读词干保留的最大字符数，避免超长路径
const MAX_STEM_LEN: usize = 48;
const FALLBACK_STEM: &str = "image";
const FALLBACK_EXT: &str = "png";
/// 图片大小上限：避免把超大文件整块读进内存
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

// ── 类型 ───────────────────────────────────────────────────────

/// 会话（聊天窗口）
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ChatSession {
    pub id: i64,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    /// 消息条数
    pub message_count: i64,
    /// 最近一条消息的预览（文件/图片消息取文件名）
    pub last_message: String,
}

/// 会话消息
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ChatMessage {
    pub id: i64,
    pub session_id: i64,
    /// `me` = 自己（右侧气泡），`other` = 对方（左侧气泡）
    pub role: String,
    /// `text` / `file` / `image`
    pub kind: String,
    /// 文字内容；文件/图片消息里是可选说明文字
    pub content: String,
    pub file_name: Option<String>,
    /// `file` 消息是原始本地路径；`image` 消息是落盘副本路径
    pub file_path: Option<String>,
    pub file_size: i64,
    pub created_at: String,
    pub updated_at: String,
    /// 文字是否被编辑过
    pub edited: bool,
    /// 是否被收藏（收藏只影响展示：气泡外框高亮 + 星星标记）
    pub favorited: bool,
}

/// 新增消息的入参（缺省字段由服务端补全）
#[derive(Debug, Deserialize)]
pub struct NewChatMessage {
    pub session_id: i64,
    pub role: Option<String>,
    pub kind: Option<String>,
    pub content: Option<String>,
    pub file_name: Option<String>,
    pub file_path: Option<String>,
    pub file_size: Option<i64>,
}

/// 已落盘的聊天图片
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ChatAttachment {
    /// 存储文件名（`<词干>-<哈希>.<扩展名>`）
    pub name: String,
    /// 完整路径（正斜杠）
    pub path: String,
    pub size: i64,
}

// ── 表结构 ─────────────────────────────────────────────────────

/// 创建会话相关表（幂等）；由 `db::init_project_database` 调用
pub fn init_chat_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_sessions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT NOT NULL,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);

        CREATE TABLE IF NOT EXISTS chat_messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  INTEGER NOT NULL,
            role        TEXT NOT NULL DEFAULT 'me',
            kind        TEXT NOT NULL DEFAULT 'text',
            content     TEXT NOT NULL DEFAULT '',
            file_name   TEXT,
            file_path   TEXT,
            file_size   INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            edited      INTEGER NOT NULL DEFAULT 0,
            favorited   INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, id);",
    )?;

    // 迁移：为旧版 chat_messages 补充 favorited 列（老库 CREATE TABLE IF NOT EXISTS 不会加列）
    let columns = conn
        .prepare("PRAGMA table_info(chat_messages)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<SqlResult<Vec<String>>>()?;
    if !columns.iter().any(|col| col == "favorited") {
        conn.execute(
            "ALTER TABLE chat_messages ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    // 列表用的派生索引：只是 (mtime,size) 命中缓存，源数据永远是 JSONL 文件本身。
    // 删掉这张表也只是变慢，结果不变。
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_index (
            file          TEXT PRIMARY KEY,
            mtime_ms      INTEGER NOT NULL,
            size          INTEGER NOT NULL,
            id            INTEGER NOT NULL,
            title         TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL,
            message_count INTEGER NOT NULL,
            last_message  TEXT NOT NULL
        );",
    )?;

    Ok(())
}

// ── 工具 ───────────────────────────────────────────────────────

fn now() -> String {
    Local::now().to_rfc3339()
}

fn to_slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 会话标题：去空白；为空时回退为「新会话」（重命名等场景，避免静默改成时间戳）
fn normalized_title(raw: &str) -> String {
    let title = raw.trim();
    if title.is_empty() {
        DEFAULT_SESSION_TITLE.to_string()
    } else {
        title.chars().take(60).collect()
    }
}

/// 新建会话的标题：显式给出则去空白后使用，否则用 `2026-09-27_10-30-15` 形式的时间戳，
/// 与前端「新建文件」的命名口径一致（本地时间、不含 `:`，两类默认名可一起排序）。
fn new_session_title(raw: &str) -> String {
    if raw.trim().is_empty() {
        Local::now().format("%Y-%m-%d_%H-%M-%S").to_string()
    } else {
        normalized_title(raw)
    }
}

/// 消息类型收敛到已知值，未知类型按文字处理
fn normalized_kind(raw: Option<&str>) -> String {
    match raw {
        Some("file") => "file".to_string(),
        Some("image") => "image".to_string(),
        _ => "text".to_string(),
    }
}

/// 发送方收敛到 `me` / `other`
fn normalized_role(raw: Option<&str>) -> String {
    match raw {
        Some("other") => "other".to_string(),
        _ => "me".to_string(),
    }
}
// ── JSONL 会话存储 ─────────────────────────────────────────────

/// 会话存储目录：始终位于应用数据目录下（私有，不写进用户工作区）
const CHAT_SESSION_DIR: &str = "chat-sessions";
/// 旧版把会话放在 `<root>/.oops/sessions/`；这两个常量只用于一次性导入
const LEGACY_SESSION_ROOT_FILE: &str = "chat-session-root";
const LEGACY_WORKSPACE_META_DIR: &str = ".oops";
const LEGACY_WORKSPACE_SESSION_DIR: &str = "sessions";
const WORKSPACE_IMPORT_MARKER: &str = ".imported-from-workspace";
/// 事件记录类型：会话 / 标题 / 消息，以及三种消息变更。
/// 全部追加写，不整文件重写；读取侧按顺序 fold 出当前状态。
const SESSION_RECORD_TYPE: &str = "session";
const TITLE_RECORD_TYPE: &str = "title";
const MESSAGE_RECORD_TYPE: &str = "message";
const MESSAGE_EDIT_RECORD_TYPE: &str = "message-edit";
const MESSAGE_FAVORITE_RECORD_TYPE: &str = "message-favorite";
const MESSAGE_DELETE_RECORD_TYPE: &str = "message-delete";
/// 旧库迁移完成标记：有了它就不再回读 SQLite，避免删掉的会话被旧库重新“复活”
const SQLITE_MIGRATION_MARKER: &str = ".migrated-from-sqlite";
/// 自增 id 状态：会话/消息删除后也不复用 id
const STORE_STATE_FILE: &str = ".state.json";
/// 新会话文件名后缀的随机字节数（8 字节 → 16 位十六进制）
const SESSION_FILE_SUFFIX_LEN: usize = 8;

/// 所有会话文件操作串行化：同一时刻只允许一个读-改-写，避免互相覆盖
static CHAT_SESSION_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// 会话文件首行：会话元数据（后续每行一条消息）
#[derive(Debug, Serialize, Deserialize, Clone)]
struct SessionHeader {
    #[serde(rename = "type")]
    record_type: String,
    id: i64,
    title: String,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    message_count: i64,
    #[serde(default)]
    last_message: String,
    /// 历史上出现过的最大消息 id（删除消息后也不回退，避免 id 复用）
    #[serde(default)]
    max_message_id: i64,
}

struct SessionFile {
    header: SessionHeader,
    messages: Vec<ChatMessage>,
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))
}

fn normalized_path_string(path: &Path) -> String {
    to_slash(path).trim_end_matches('/').to_lowercase()
}

fn same_fs_path(a: &Path, b: &Path) -> bool {
    normalized_path_string(a) == normalized_path_string(b)
}

/// 会话目录：应用数据目录下的私有目录。
///
/// 会话不再写进用户工作区——工作区是用户的，任何杂物（导出的 JSONL、备份、
/// 空文件）都可能混进来；私有目录只由本应用写入。
fn chat_session_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join(CHAT_SESSION_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("创建会话目录失败: {}", e))?;
    import_workspace_sessions(app, &dir)?;
    Ok(dir)
}

/// 把旧版工作区会话目录里的 JSONL 搬进私有目录，并合并自增 id 状态。返回搬移文件数。
///
/// 抽成独立函数是为了能脱离 AppHandle 单测；导入是「搬」不是「复制」，
/// 旧目录里留下的只有 `.state.json` 这类元数据。
fn import_legacy_workspace(source: &Path, target: &Path) -> Result<usize, String> {
    if !source.is_dir() || same_fs_path(source, target) {
        return Ok(0);
    }
    fs::create_dir_all(target).map_err(|e| format!("创建会话目录失败: {}", e))?;

    let mut moved = 0usize;
    if let Ok(entries) = fs::read_dir(source) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(name) = path.file_name() {
                if move_file_if_absent(&path, &target.join(name))? {
                    moved += 1;
                }
            }
        }
    }

    let source_state = read_store_state(source)?;
    if source_state.max_session_id > 0 || source_state.max_message_id > 0 {
        let mut target_state = read_store_state(target)?;
        target_state.max_session_id = target_state
            .max_session_id
            .max(source_state.max_session_id);
        target_state.max_message_id = target_state
            .max_message_id
            .max(source_state.max_message_id);
        write_store_state(target, &target_state)?;
    }
    Ok(moved)
}

/// 一次性把旧版 `<root>/.oops/sessions/*.jsonl` 搬进私有目录。
///
/// 有了标记就不再扫描工作区；导入是「搬」而不是「复制」，之后 `.oops` 删掉也不丢会话。
fn import_workspace_sessions(app: &AppHandle, target: &Path) -> Result<(), String> {
    let marker = target.join(WORKSPACE_IMPORT_MARKER);
    if marker.exists() {
        return Ok(());
    }
    let root_file = app_data_dir(app)?.join(LEGACY_SESSION_ROOT_FILE);
    if let Ok(raw) = fs::read_to_string(&root_file) {
        let root = PathBuf::from(raw.trim());
        let legacy = root
            .join(LEGACY_WORKSPACE_META_DIR)
            .join(LEGACY_WORKSPACE_SESSION_DIR);
        import_legacy_workspace(&legacy, target)?;
        // 会话搬完后旧目录只剩元数据：状态已合并、迁移标记搬走，能删就删，
        // 不在用户工作区里留 `.oops/sessions` 空壳
        for name in [SQLITE_MIGRATION_MARKER] {
            let from = legacy.join(name);
            if from.is_file() {
                let _ = move_file_if_absent(&from, &target.join(name));
            }
        }
        let _ = fs::remove_file(legacy.join(STORE_STATE_FILE));
        let _ = fs::remove_dir(&legacy);
        if let Some(meta_dir) = legacy.parent() {
            let _ = fs::remove_dir(meta_dir);
        }
    }
    let _ = fs::remove_file(&root_file);
    let _ = fs::write(&marker, b"1");
    Ok(())
}

/// 加锁后执行一次会话目录操作（读改写必须串行）
fn with_chat_store<T>(
    app: &AppHandle,
    action: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = CHAT_SESSION_LOCK.lock();
    let dir = chat_session_dir(app)?;
    action(&dir)
}

/// 跨盘/跨目录移动文件；目标已存在时保留目标，不覆盖用户文件。
fn move_file_if_absent(source: &Path, target: &Path) -> Result<bool, String> {
    if target.exists() {
        return Ok(false);
    }
    match fs::rename(source, target) {
        Ok(()) => Ok(true),
        Err(_) => {
            fs::copy(source, target)
                .map_err(|e| format!("迁移会话文件失败 {}: {}", source.display(), e))?;
            fs::remove_file(source)
                .map_err(|e| format!("清理旧会话文件失败 {}: {}", source.display(), e))?;
            Ok(true)
        }
    }
}

/// 导出文件名统一以 `.jsonl` 结尾；用户没写扩展名时补上，已有其他扩展名时保留原名再追加。
fn ensure_jsonl_extension(path: &Path) -> PathBuf {
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
    {
        return path.to_path_buf();
    }
    let mut name = path.as_os_str().to_os_string();
    name.push(".jsonl");
    PathBuf::from(name)
}

/// 批量导出的可读文件名：`session-<id>-<清洗后的标题>.jsonl`
fn export_session_stem(title: &str, id: i64) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | ' ' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let stem: String = trimmed.chars().take(60).collect();
    let stem = stem.trim();
    if stem.is_empty() {
        format!("session-{id}")
    } else {
        format!("session-{id}-{stem}")
    }
}

fn export_session_file(source: &Path, target: &Path) -> Result<PathBuf, String> {
    if !source.is_file() {
        return Err(format!("会话文件不存在: {}", source.display()));
    }
    let target = ensure_jsonl_extension(target);
    if same_fs_path(source, &target) {
        return Ok(target);
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建导出目录失败 {}: {}", parent.display(), e))?;
    }
    fs::copy(source, &target)
        .map_err(|e| format!("导出会话失败 {}: {}", target.display(), e))?;
    Ok(target)
}

fn export_all_sessions_to(source_dir: &Path, target_dir: &Path) -> Result<usize, String> {
    if same_fs_path(source_dir, target_dir) {
        return Err("导出目录不能是会话存储目录本身".to_string());
    }
    fs::create_dir_all(target_dir)
        .map_err(|e| format!("创建导出目录失败 {}: {}", target_dir.display(), e))?;

    let mut exported = 0usize;
    for id in session_ids(source_dir)? {
        let source = session_file_path(source_dir, id);
        let header = read_session_header(&source)?;
        let base = export_session_stem(&header.title, id);
        let mut target = target_dir.join(format!("{base}.jsonl"));
        let mut suffix = 2;
        while target.exists() {
            target = target_dir.join(format!("{base}-{suffix}.jsonl"));
            suffix += 1;
        }
        fs::copy(&source, &target)
            .map_err(|e| format!("导出会话失败 {}: {}", target.display(), e))?;
        exported += 1;
    }
    Ok(exported)
}

/// 导出单个会话为 JSONL；返回实际写入路径。
#[tauri::command]
pub fn export_chat_session(
    app: AppHandle,
    id: i64,
    target_path: String,
) -> Result<String, String> {
    let _guard = CHAT_SESSION_LOCK.lock();
    let dir = chat_session_dir(&app)?;
    Ok(to_slash(&export_session_file(
        &session_file_path(&dir, id),
        Path::new(&target_path),
    )?))
}

/// 导出全部会话到指定目录，每个会话一个 JSONL；返回导出数量。
#[tauri::command]
pub fn export_all_chat_sessions(
    app: AppHandle,
    target_dir: String,
) -> Result<usize, String> {
    let _guard = CHAT_SESSION_LOCK.lock();
    let dir = chat_session_dir(&app)?;
    export_all_sessions_to(&dir, Path::new(&target_dir))
}

/// 新建会话的文件名：`<本地时间>_<随机后缀>.jsonl`。
///
/// 文件名只是 key，**不代表会话 id**：id 存在首条 `session` 记录里，
/// 所以文件被复制/改名也不会把 id 弄错，普通 JSONL 也不会被误认成会话。
fn session_file_name() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);

    let mut hasher = Sha256::new();
    hasher.update(nanos.to_le_bytes());
    hasher.update(counter.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    let digest = hasher.finalize();
    let mut suffix = String::with_capacity(SESSION_FILE_SUFFIX_LEN * 2);
    for byte in &digest[..SESSION_FILE_SUFFIX_LEN] {
        let _ = write!(suffix, "{:02x}", byte);
    }
    format!(
        "{}_{}.jsonl",
        Local::now().format("%Y%m%dT%H%M%S"),
        suffix
    )
}

/// 目录里所有会话文件，按文件名排序（排序稳定，列表结果才稳定）。
fn session_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.is_file()
                        && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

/// 按会话 id 找文件：id 来自文件内容，所以只能逐个 fold（文件数很少）。
fn session_file_path(dir: &Path, id: i64) -> PathBuf {
    for path in session_files(dir) {
        if fold_session(&path).is_some_and(|file| file.header.id == id) {
            return path;
        }
    }
    // 找不到时给一个旧式路径，调用方按「文件不存在」处理
    dir.join(format!("{id}.jsonl"))
}

/// 时间戳只用于「最近编辑」，取字典序最大即可（同为本地时区的 RFC3339）。
fn touch_timestamp(target: &mut String, candidate: &str) {
    if candidate > target.as_str() {
        target.clear();
        target.push_str(candidate);
    }
}

/// 容错读取：逐行解析，坏行 / 未知类型直接跳过。
///
/// 这是与旧实现最大的区别：一行坏数据只会丢那一条记录，不会让整个会话甚至
/// 整个会话列表加载失败；同时自然兼容旧版「header + 纯消息行」格式。
fn fold_session(path: &Path) -> Option<SessionFile> {
    let content = fs::read_to_string(path).ok()?;
    let fallback_id = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .and_then(|stem| stem.parse::<i64>().ok());

    let mut header = SessionHeader {
        record_type: SESSION_RECORD_TYPE.to_string(),
        id: 0,
        title: String::new(),
        created_at: String::new(),
        updated_at: String::new(),
        message_count: 0,
        last_message: String::new(),
        max_message_id: 0,
    };
    let mut messages: Vec<ChatMessage> = Vec::new();
    let mut has_session_record = false;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let record_type = record.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match record_type {
            SESSION_RECORD_TYPE => {
                has_session_record = true;
                if let Some(id) = record.get("id").and_then(|v| v.as_i64()) {
                    header.id = id;
                }
                if header.title.is_empty() {
                    if let Some(title) = record.get("title").and_then(|v| v.as_str()) {
                        header.title = title.to_string();
                    }
                }
                if header.created_at.is_empty() {
                    if let Some(ts) = record.get("created_at").and_then(|v| v.as_str()) {
                        header.created_at = ts.to_string();
                    }
                }
                if let Some(ts) = record.get("updated_at").and_then(|v| v.as_str()) {
                    touch_timestamp(&mut header.updated_at, ts);
                }
                if let Some(max) = record.get("max_message_id").and_then(|v| v.as_i64()) {
                    header.max_message_id = header.max_message_id.max(max);
                }
            }
            TITLE_RECORD_TYPE => {
                if let Some(title) = record.get("title").and_then(|v| v.as_str()) {
                    header.title = title.to_string();
                }
                if let Some(ts) = record.get("updated_at").and_then(|v| v.as_str()) {
                    touch_timestamp(&mut header.updated_at, ts);
                }
            }
            MESSAGE_RECORD_TYPE | "" => {
                // 旧版消息行没有 `type`，整行就是一个 ChatMessage
                let Ok(message) = serde_json::from_value::<ChatMessage>(record.clone()) else {
                    continue;
                };
                header.max_message_id = header.max_message_id.max(message.id);
                touch_timestamp(&mut header.updated_at, &message.updated_at);
                if messages.iter().all(|existing| existing.id != message.id) {
                    messages.push(message);
                }
            }
            MESSAGE_EDIT_RECORD_TYPE => {
                let Some(id) = record.get("id").and_then(|v| v.as_i64()) else {
                    continue;
                };
                let Some(message) = messages.iter_mut().find(|item| item.id == id) else {
                    continue;
                };
                if let Some(content) = record.get("content").and_then(|v| v.as_str()) {
                    message.content = content.to_string();
                }
                if let Some(ts) = record.get("updated_at").and_then(|v| v.as_str()) {
                    message.updated_at = ts.to_string();
                    touch_timestamp(&mut header.updated_at, ts);
                }
                message.edited = true;
            }
            MESSAGE_FAVORITE_RECORD_TYPE => {
                let Some(id) = record.get("id").and_then(|v| v.as_i64()) else {
                    continue;
                };
                let Some(message) = messages.iter_mut().find(|item| item.id == id) else {
                    continue;
                };
                if let Some(favorited) = record.get("favorited").and_then(|v| v.as_bool()) {
                    message.favorited = favorited;
                }
            }
            MESSAGE_DELETE_RECORD_TYPE => {
                let Some(id) = record.get("id").and_then(|v| v.as_i64()) else {
                    continue;
                };
                messages.retain(|item| item.id != id);
                if let Some(ts) = record.get("updated_at").and_then(|v| v.as_str()) {
                    touch_timestamp(&mut header.updated_at, ts);
                }
            }
            _ => {}
        }
    }

    if header.id == 0 {
        header.id = fallback_id?;
    }
    // 没有任何有效记录的（空文件、乱写的 JSONL）不是会话
    if !has_session_record && messages.is_empty() {
        return None;
    }
    if header.title.is_empty() {
        header.title = header.id.to_string();
    }
    if header.created_at.is_empty() {
        header.created_at = messages
            .first()
            .map(|message| message.created_at.clone())
            .unwrap_or_default();
    }
    if header.updated_at.is_empty() {
        header.updated_at = header.created_at.clone();
    }

    messages.sort_by_key(|message| message.id);
    refresh_header(&mut header, &messages);
    Some(SessionFile { header, messages })
}

/// 追加一行记录：会话文件是事件日志，任何变更只 append，不重写整个文件。
fn append_record(path: &Path, record: &serde_json::Value) -> Result<(), String> {
    use std::io::Write as _;

    let line =
        serde_json::to_string(record).map_err(|e| format!("序列化会话记录失败: {}", e))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("打开会话文件失败 {}: {}", path.display(), e))?;
    writeln!(file, "{}", line)
        .map_err(|e| format!("写入会话失败 {}: {}", path.display(), e))?;
    file.flush()
        .map_err(|e| format!("写入会话失败 {}: {}", path.display(), e))?;
    Ok(())
}

/// 新建/迁移时一次性写完整文件（session 记录 + 标题 + 消息），之后只追加。
fn write_session_file(
    path: &Path,
    header: &SessionHeader,
    messages: &[ChatMessage],
) -> Result<(), String> {
    let mut output = serde_json::to_string(header)
        .map_err(|e| format!("序列化会话失败: {}", e))?;
    output.push('\n');
    for message in messages {
        let mut record = serde_json::to_value(message)
            .map_err(|e| format!("序列化消息失败: {}", e))?;
        record["type"] = serde_json::Value::String(MESSAGE_RECORD_TYPE.to_string());
        output.push_str(
            &serde_json::to_string(&record).map_err(|e| format!("序列化消息失败: {}", e))?,
        );
        output.push('\n');
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建会话目录失败 {}: {}", parent.display(), e))?;
    }
    fs::write(path, output)
        .map_err(|e| format!("写入会话文件失败 {}: {}", path.display(), e))
}

/// 会话列表里的「最近一条消息」预览：文字取正文，文件/图片取文件名
fn message_preview(message: &ChatMessage) -> String {
    if message.kind == "text" {
        message.content.clone()
    } else {
        message.file_name.clone().unwrap_or_default()
    }
}

fn refresh_header(header: &mut SessionHeader, messages: &[ChatMessage]) {
    header.message_count = messages.len() as i64;
    header.last_message = messages
        .last()
        .map(message_preview)
        .unwrap_or_default();
}

fn session_from_header(header: &SessionHeader) -> ChatSession {
    ChatSession {
        id: header.id,
        title: header.title.clone(),
        created_at: header.created_at.clone(),
        updated_at: header.updated_at.clone(),
        message_count: header.message_count,
        last_message: header.last_message.clone(),
    }
}

fn read_session_header(path: &Path) -> Result<SessionHeader, String> {
    fold_session(path)
        .map(|file| file.header)
        .ok_or_else(|| format!("会话文件无可读记录: {}", path.display()))
}

fn load_session_file(path: &Path) -> Result<SessionFile, String> {
    fold_session(path).ok_or_else(|| format!("会话文件无可读记录: {}", path.display()))
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreState {
    #[serde(default)]
    max_session_id: i64,
    #[serde(default)]
    max_message_id: i64,
}

fn read_store_state(dir: &Path) -> Result<StoreState, String> {
    let path = dir.join(STORE_STATE_FILE);
    if !path.exists() {
        return Ok(StoreState::default());
    }
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("读取会话状态失败 {}: {}", path.display(), e))?;
    serde_json::from_str(&content).map_err(|e| format!("会话状态解析失败: {}", e))
}

fn write_store_state(dir: &Path, state: &StoreState) -> Result<(), String> {
    let path = dir.join(STORE_STATE_FILE);
    let temp = dir.join(format!("{}.tmp", STORE_STATE_FILE));
    let content = serde_json::to_string(state).map_err(|e| format!("序列化会话状态失败: {}", e))?;
    fs::write(&temp, content).map_err(|e| format!("写入会话状态失败: {}", e))?;
    fs::rename(&temp, &path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("替换会话状态失败: {}", e)
    })
}

fn session_ids(dir: &Path) -> Result<Vec<i64>, String> {
    let mut ids: Vec<i64> = session_files(dir)
        .iter()
        .filter_map(|path| fold_session(path).map(|file| file.header.id))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

fn next_session_id(dir: &Path) -> Result<i64, String> {
    let state = read_store_state(dir)?;
    let max_on_disk = session_ids(dir)?.last().copied().unwrap_or(0);
    Ok(state.max_session_id.max(max_on_disk) + 1)
}

/// 消息 id 全局递增（和旧 SQLite AUTOINCREMENT 一致）：编辑/删除只带 id，不带 session。
/// 头里的 `max_message_id` 记录历史最大值，删除最后一条消息后也不会复用 id。
fn next_message_id(dir: &Path) -> Result<i64, String> {
    let mut max = read_store_state(dir)?.max_message_id;
    for path in session_files(dir) {
        let Some(file) = fold_session(&path) else {
            continue;
        };
        max = max.max(file.header.max_message_id);
        for message in file.messages {
            max = max.max(message.id);
        }
    }
    Ok(max + 1)
}

/// 容错列表：坏文件跳过，绝不让一个文件拖垮整个列表。
fn list_sessions(dir: &Path) -> Result<Vec<ChatSession>, String> {
    let mut sessions: Vec<ChatSession> = session_files(dir)
        .iter()
        .filter_map(|path| fold_session(path).map(|file| session_from_header(&file.header)))
        .collect();
    sessions.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(sessions)
}

/// 索引里的缓存行：(mtime_ms, size, 会话元数据)。任一不匹配就重新 fold 这个文件。
struct CachedSession {
    mtime_ms: i64,
    size: i64,
    session: ChatSession,
}

fn file_stamp(path: &Path) -> Option<(i64, i64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    Some((mtime_ms, meta.len() as i64))
}

fn load_session_index() -> Result<HashMap<String, CachedSession>, String> {
    crate::db::with_db(|conn| {
        let mut stmt = conn.prepare(
            "SELECT file, mtime_ms, size, id, title, created_at, updated_at,
                    message_count, last_message
             FROM chat_index",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                CachedSession {
                    mtime_ms: row.get(1)?,
                    size: row.get(2)?,
                    session: ChatSession {
                        id: row.get(3)?,
                        title: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                        message_count: row.get(7)?,
                        last_message: row.get(8)?,
                    },
                },
            ))
        })?;
        let mut index = HashMap::new();
        for row in rows {
            let (file, cached) = row?;
            index.insert(file, cached);
        }
        Ok(index)
    })
}

/// 增量刷新索引：只回写变化的文件，并删掉已经不存在的文件对应的行。
fn save_session_index(changed: &[(String, i64, i64, ChatSession)], present: &[String]) -> Result<(), String> {
    let stale: Vec<String> = load_session_index()?
        .keys()
        .filter(|file| !present.iter().any(|name| name == *file))
        .cloned()
        .collect();

    crate::db::with_db(|conn| {
        for (file, mtime_ms, size, session) in changed {
            conn.execute(
                "INSERT INTO chat_index
                    (file, mtime_ms, size, id, title, created_at, updated_at, message_count, last_message)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(file) DO UPDATE SET
                    mtime_ms = excluded.mtime_ms,
                    size = excluded.size,
                    id = excluded.id,
                    title = excluded.title,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    message_count = excluded.message_count,
                    last_message = excluded.last_message",
                params![
                    file,
                    mtime_ms,
                    size,
                    session.id,
                    session.title,
                    session.created_at,
                    session.updated_at,
                    session.message_count,
                    session.last_message,
                ],
            )?;
        }
        for file in &stale {
            conn.execute("DELETE FROM chat_index WHERE file = ?1", params![file])?;
        }
        Ok(())
    })
}

/// 列表 = 目录扫描 + 增量索引；索引不可用（DB 未初始化/表被删）时退回纯 fold。
fn indexed_sessions(dir: &Path) -> Result<Vec<ChatSession>, String> {
    let files = session_files(dir);
    let cached = load_session_index().unwrap_or_default();

    let mut sessions = Vec::with_capacity(files.len());
    let mut changed: Vec<(String, i64, i64, ChatSession)> = Vec::new();
    let mut present: Vec<String> = Vec::with_capacity(files.len());

    for path in &files {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some((mtime_ms, size)) = file_stamp(path) else {
            continue;
        };
        present.push(name.to_string());

        if let Some(hit) = cached.get(name) {
            if hit.mtime_ms == mtime_ms && hit.size == size {
                sessions.push(hit.session.clone());
                continue;
            }
        }
        let Some(file) = fold_session(path) else {
            continue;
        };
        let session = session_from_header(&file.header);
        changed.push((name.to_string(), mtime_ms, size, session.clone()));
        sessions.push(session);
    }

    if !changed.is_empty() || cached.len() != present.len() {
        // 索引写失败不影响正确性，下次再补
        let _ = save_session_index(&changed, &present);
    }

    sessions.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(sessions)
}

fn read_session(dir: &Path, id: i64) -> Result<Option<ChatSession>, String> {
    let path = session_file_path(dir, id);
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(session_from_header(&read_session_header(&path)?)))
}

fn insert_session(dir: &Path, raw_title: &str) -> Result<ChatSession, String> {
    let id = next_session_id(dir)?;
    let title = new_session_title(raw_title);
    let now = now();
    let header = SessionHeader {
        record_type: SESSION_RECORD_TYPE.to_string(),
        id,
        title,
        created_at: now.clone(),
        updated_at: now,
        message_count: 0,
        last_message: String::new(),
        max_message_id: 0,
    };
    // 文件名与 id 解耦：用时间 + 随机后缀，id 只写在内容里
    write_session_file(&dir.join(session_file_name()), &header, &[])?;

    let mut state = read_store_state(dir)?;
    state.max_session_id = state.max_session_id.max(id);
    write_store_state(dir, &state)?;
    Ok(session_from_header(&header))
}

fn rename_session(dir: &Path, id: i64, title: &str) -> Result<Option<ChatSession>, String> {
    let path = session_file_path(dir, id);
    if !path.exists() {
        return Ok(None);
    }
    // 重命名属于元数据变更：追加一条 title 记录，且不推进 updated_at
    // （「最近编辑时间」只反映消息变化）
    append_record(
        &path,
        &serde_json::json!({
            "type": TITLE_RECORD_TYPE,
            "title": normalized_title(title),
        }),
    )?;
    read_session(dir, id)
}

fn remove_session(dir: &Path, id: i64) -> Result<bool, String> {
    let path = session_file_path(dir, id);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path).map_err(|e| format!("删除会话失败 {}: {}", path.display(), e))?;
    Ok(true)
}

/// 插入消息并推进所属会话的最近编辑时间；会话不存在时返回 None
fn insert_message(dir: &Path, input: NewChatMessage) -> Result<Option<ChatMessage>, String> {
    let path = session_file_path(dir, input.session_id);
    if !path.exists() {
        return Ok(None);
    }
    let now = now();
    let message = ChatMessage {
        id: next_message_id(dir)?,
        session_id: input.session_id,
        role: normalized_role(input.role.as_deref()),
        kind: normalized_kind(input.kind.as_deref()),
        content: input.content.unwrap_or_default(),
        file_name: input.file_name,
        file_path: input.file_path,
        file_size: input.file_size.unwrap_or(0),
        created_at: now.clone(),
        updated_at: now.clone(),
        edited: false,
        favorited: false,
    };
    // 追加一行，不重写已有内容：会话越大也不会越写越慢
    let mut record =
        serde_json::to_value(&message).map_err(|e| format!("序列化消息失败: {}", e))?;
    record["type"] = serde_json::Value::String(MESSAGE_RECORD_TYPE.to_string());
    append_record(&path, &record)?;

    let mut state = read_store_state(dir)?;
    state.max_message_id = state.max_message_id.max(message.id);
    write_store_state(dir, &state)?;
    Ok(Some(message))
}

fn locate_message(dir: &Path, id: i64) -> Result<Option<(PathBuf, SessionFile, usize)>, String> {
    for path in session_files(dir) {
        let Some(file) = fold_session(&path) else {
            continue;
        };
        if let Some(index) = file.messages.iter().position(|message| message.id == id) {
            return Ok(Some((path, file, index)));
        }
    }
    Ok(None)
}

/// 编辑消息文字；消息不存在时返回 None
fn update_message(dir: &Path, id: i64, content: &str) -> Result<Option<ChatMessage>, String> {
    let Some((path, mut file, index)) = locate_message(dir, id)? else {
        return Ok(None);
    };
    let now = now();
    append_record(
        &path,
        &serde_json::json!({
            "type": MESSAGE_EDIT_RECORD_TYPE,
            "id": id,
            "content": content,
            "updated_at": now,
        }),
    )?;
    let message = &mut file.messages[index];
    message.content = content.to_string();
    message.updated_at = now;
    message.edited = true;
    Ok(Some(message.clone()))
}

/// 删除消息并推进所属会话的最近编辑时间；返回是否存在该消息
fn remove_message(dir: &Path, id: i64) -> Result<bool, String> {
    let Some((path, _file, _index)) = locate_message(dir, id)? else {
        return Ok(false);
    };
    // 日志式删除：追加删除事件，历史消息仍留在文件里（可回溯 / 不会因为写一半丢数据）
    append_record(
        &path,
        &serde_json::json!({
            "type": MESSAGE_DELETE_RECORD_TYPE,
            "id": id,
            "updated_at": now(),
        }),
    )?;
    Ok(true)
}

/// 收藏 / 取消收藏消息；消息不存在时返回 None。
///
/// 只改展示标记：既不写 `updated_at`（否则会显示成"已编辑"），
/// 也不推进会话的最近编辑时间（收藏不是内容变更，不该让会话在列表里往前走）。
fn set_message_favorite(
    dir: &Path,
    id: i64,
    favorited: bool,
) -> Result<Option<ChatMessage>, String> {
    let Some((path, mut file, index)) = locate_message(dir, id)? else {
        return Ok(None);
    };
    append_record(
        &path,
        &serde_json::json!({
            "type": MESSAGE_FAVORITE_RECORD_TYPE,
            "id": id,
            "favorited": favorited,
        }),
    )?;
    file.messages[index].favorited = favorited;
    Ok(Some(file.messages[index].clone()))
}

// ── 搜索 ───────────────────────────────────────────────────────

/// 搜索结果上限：超出即标记截断（前端提示缩小范围）
const MESSAGE_SEARCH_MAX: usize = 200;

/// 会话消息命中
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ChatMessageMatch {
    pub message_id: i64,
    pub session_id: i64,
    pub session_title: String,
    pub role: String,
    pub kind: String,
    /// 命中预览：文字消息取命中行，文件/图片消息取文件名
    pub content: String,
    pub created_at: String,
}

/// 消息搜索结果
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ChatMessageSearchResult {
    pub matches: Vec<ChatMessageMatch>,
    pub truncated: bool,
}

/// RFC3339 时间转 Unix 毫秒；解析失败返回 None（按不命中处理）
fn parse_ms(rfc3339: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// 命中行预览：与文件内容搜索同口径（取第一个命中行，最多 120 字符）
fn match_preview(text: &str, query: &str) -> String {
    let needle = query.to_lowercase();
    let line = text
        .lines()
        .find(|line| line.to_lowercase().contains(&needle))
        .or_else(|| text.lines().next())
        .unwrap_or("")
        .trim();
    line.chars().take(120).collect()
}

/// 消息搜索：按关键词匹配正文或文件名（大小写不敏感），可按会话集合与创建时间范围收窄。
fn search_messages(
    dir: &Path,
    query: &str,
    session_filter: &[i64],
    created_after_ms: Option<i64>,
    created_before_ms: Option<i64>,
) -> Result<ChatMessageSearchResult, String> {
    let needle = query.to_lowercase();
    let mut matches = Vec::new();

    for path in session_files(dir) {
        // 坏文件跳过：一个文件损坏不该让整个搜索失败
        let Some(file) = fold_session(&path) else {
            continue;
        };
        let session_id = file.header.id;
        // 空集合表示不限会话
        if !session_filter.is_empty() && !session_filter.contains(&session_id) {
            continue;
        }
        for message in &file.messages {
            let file_name = message.file_name.as_deref().unwrap_or("");
            if !message.content.to_lowercase().contains(&needle)
                && !file_name.to_lowercase().contains(&needle)
            {
                continue;
            }
            let Some(ms) = parse_ms(&message.created_at) else {
                continue;
            };
            if created_after_ms.is_some_and(|after| ms < after) {
                continue;
            }
            if created_before_ms.is_some_and(|before| ms > before) {
                continue;
            }
            let preview_source = if message.content.is_empty() {
                file_name
            } else {
                message.content.as_str()
            };
            matches.push(ChatMessageMatch {
                message_id: message.id,
                session_id,
                session_title: file.header.title.clone(),
                role: message.role.clone(),
                kind: message.kind.clone(),
                content: match_preview(preview_source, query),
                created_at: message.created_at.clone(),
            });
        }
    }

    matches.sort_by(|a, b| b.message_id.cmp(&a.message_id));
    let truncated = matches.len() > MESSAGE_SEARCH_MAX;
    matches.truncate(MESSAGE_SEARCH_MAX);
    Ok(ChatMessageSearchResult { matches, truncated })
}

/// 把旧版 SQLite 里的会话/消息导出成 JSONL。
///
/// 幂等：目标文件已存在就跳过，不覆盖用户后来改过的会话；旧表保留不删，方便回退。
pub fn migrate_chat_to_jsonl(app: &AppHandle, conn: &Connection) -> Result<(), String> {
    let dir = chat_session_dir(app)?;
    migrate_chat_to_jsonl_in(&dir, conn)
}

fn migrate_chat_to_jsonl_in(dir: &Path, conn: &Connection) -> Result<(), String> {
    let _guard = CHAT_SESSION_LOCK.lock();
    let marker = dir.join(SQLITE_MIGRATION_MARKER);
    if marker.exists() {
        return Ok(());
    }

    let mut state = read_store_state(dir)?;
    let legacy_sessions = {
        let mut stmt = conn
            .prepare("SELECT id, title, created_at, updated_at FROM chat_sessions ORDER BY id ASC")
            .map_err(|e| format!("读取旧会话失败: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| format!("读取旧会话失败: {}", e))?;
        rows.collect::<SqlResult<Vec<_>>>()
            .map_err(|e| format!("读取旧会话失败: {}", e))?
    };

    for (id, title, created_at, updated_at) in legacy_sessions {
        let path = session_file_path(&dir, id);
        if path.exists() {
            continue;
        }
        let messages = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, session_id, role, kind, content, file_name, file_path,
                            file_size, created_at, updated_at, edited, favorited
                     FROM chat_messages WHERE session_id = ?1 ORDER BY id ASC",
                )
                .map_err(|e| format!("读取旧消息失败: {}", e))?;
            let rows = stmt
                .query_map(params![id], |row| {
                    Ok(ChatMessage {
                        id: row.get(0)?,
                        session_id: row.get(1)?,
                        role: row.get(2)?,
                        kind: row.get(3)?,
                        content: row.get(4)?,
                        file_name: row.get(5)?,
                        file_path: row.get(6)?,
                        file_size: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                        edited: row.get::<_, i64>(10)? != 0,
                        favorited: row.get::<_, i64>(11)? != 0,
                    })
                })
                .map_err(|e| format!("读取旧消息失败: {}", e))?;
            rows.collect::<SqlResult<Vec<_>>>()
                .map_err(|e| format!("读取旧消息失败: {}", e))?
        };
        let header = SessionHeader {
            record_type: SESSION_RECORD_TYPE.to_string(),
            id,
            title,
            created_at,
            updated_at,
            message_count: 0,
            last_message: String::new(),
            max_message_id: messages.last().map(|message| message.id).unwrap_or(0),
        };
        write_session_file(&dir.join(session_file_name()), &header, &messages)?;
        state.max_session_id = state.max_session_id.max(id);
        if let Some(last) = messages.last() {
            state.max_message_id = state.max_message_id.max(last.id);
        }
    }

    write_store_state(&dir, &state)?;
    fs::write(&marker, b"1").map_err(|e| format!("写入会话迁移标记失败: {}", e))?;
    Ok(())
}

// ── 图片落盘 ───────────────────────────────────────────────────

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(hex, "{:02x}", byte);
    }
    hex
}

/// 取 `foo/bar/baz.PNG` 中的 `baz`
fn file_stem_of(raw_name: &str) -> &str {
    let name = raw_name.rsplit(['/', '\\']).next().unwrap_or(raw_name);
    match name.rfind('.') {
        Some(idx) if idx > 0 => &name[..idx],
        _ => name,
    }
}

/// 摘掉 `image-3f9ac2b1c2d3e4f5` 这类本模块生成的尾部哈希，避免重复发送时哈希层层叠加
fn strip_hash_suffix(stem: &str) -> &str {
    match stem.rsplit_once('-') {
        Some((head, tail))
            if (HASH_LEN..=64).contains(&tail.len())
                && tail.chars().all(|c| c.is_ascii_hexdigit()) =>
        {
            head
        }
        _ => stem,
    }
}

/// 从来源文件名提取可读词干：去掉路径/扩展名/非法字符并限长
fn normalized_stem(raw_name: &str) -> String {
    let cleaned: String = file_stem_of(raw_name)
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect();
    let stem: String = strip_hash_suffix(&cleaned)
        .trim_matches(['-', '_', '.'])
        .chars()
        .take(MAX_STEM_LEN)
        .collect();
    let stem = stem.trim_matches(['-', '_', '.']);
    if stem.is_empty() {
        FALLBACK_STEM.to_string()
    } else {
        stem.to_string()
    }
}

/// 扩展名统一小写；非法或缺失时回退为 png
fn normalized_ext(raw_name: &str) -> String {
    let name = raw_name.rsplit(['/', '\\']).next().unwrap_or(raw_name);
    let ext = match name.rfind('.') {
        Some(idx) if idx > 0 && idx + 1 < name.len() => name[idx + 1..].to_ascii_lowercase(),
        _ => return FALLBACK_EXT.to_string(),
    };
    if ext.len() <= 12 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        ext
    } else {
        FALLBACK_EXT.to_string()
    }
}

/// 图片目录：应用数据目录下的 `chat-attachments/`
fn attachment_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {}", e))?;
    let dir = app_dir.join(CHAT_ATTACHMENT_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("创建聊天图片目录失败: {}", e))?;
    Ok(dir)
}

/// 按内容哈希落盘一张图片：同内容复用已有副本，只返回其路径
fn store_image_bytes(
    dir: &Path,
    bytes: &[u8],
    raw_name: &str,
) -> Result<ChatAttachment, String> {
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }

    let hash = sha256_hex(bytes);
    let suffix = format!("-{}", &hash[..HASH_LEN]);

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            let matches_name = match file_name.rfind('.') {
                Some(idx) if idx > 0 => file_name[..idx].ends_with(&suffix),
                _ => file_name.ends_with(&suffix),
            };
            if !matches_name {
                continue;
            }
            let path = entry.path();
            // 内容一致才算命中：防止手工替换过同名文件时被误判为同一附件
            if fs::read(&path).is_ok_and(|content| content == bytes) {
                return Ok(ChatAttachment {
                    name: file_name,
                    path: to_slash(&path),
                    size: bytes.len() as i64,
                });
            }
        }
    }

    let stem = normalized_stem(raw_name);
    let ext = normalized_ext(raw_name);
    let mut path = dir.join(format!("{}-{}.{}", stem, &hash[..HASH_LEN], ext));
    if path.exists() {
        // 同名但内容不同（用户手工替换过或哈希前缀撞车），不覆盖，改用完整哈希
        path = dir.join(format!("{}-{}.{}", stem, hash, ext));
    }
    fs::write(&path, bytes).map_err(|e| format!("保存图片失败: {}", e))?;

    Ok(ChatAttachment {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: to_slash(&path),
        size: bytes.len() as i64,
    })
}

// ── Tauri 命令 ─────────────────────────────────────────────────

/// 全部会话，按最近编辑时间倒序
#[tauri::command]
pub fn get_chat_sessions(app: AppHandle) -> Result<Vec<ChatSession>, String> {
    with_chat_store(&app, |dir| match indexed_sessions(dir) {
        Ok(sessions) => Ok(sessions),
        // 索引层出错（例如 DB 不可用）时退回直接 fold，保证列表始终可用
        Err(_) => list_sessions(dir),
    })
}

/// 新建会话；标题缺省为时间戳（与前端「新建文件」同名口径）
#[tauri::command]
pub fn add_chat_session(app: AppHandle, title: Option<String>) -> Result<ChatSession, String> {
    with_chat_store(&app, |dir| insert_session(dir, title.as_deref().unwrap_or("")))
}

#[tauri::command]
pub fn rename_chat_session(
    app: AppHandle,
    id: i64,
    title: String,
) -> Result<ChatSession, String> {
    with_chat_store(&app, |dir| rename_session(dir, id, &title))?
        .ok_or_else(|| format!("会话不存在: {}", id))
}

#[tauri::command]
pub fn delete_chat_session(app: AppHandle, id: i64) -> Result<(), String> {
    if with_chat_store(&app, |dir| remove_session(dir, id))? {
        Ok(())
    } else {
        Err(format!("会话不存在: {}", id))
    }
}

#[tauri::command]
pub fn get_chat_messages(app: AppHandle, session_id: i64) -> Result<Vec<ChatMessage>, String> {
    with_chat_store(&app, |dir| {
        let path = session_file_path(dir, session_id);
        if !path.exists() {
            return Ok(Vec::new());
        }
        Ok(load_session_file(&path)?.messages)
    })
}

#[tauri::command]
pub fn add_chat_message(
    app: AppHandle,
    message: NewChatMessage,
) -> Result<ChatMessage, String> {
    with_chat_store(&app, |dir| insert_message(dir, message))?
        .ok_or_else(|| "会话不存在，无法发送消息".to_string())
}

#[tauri::command]
pub fn update_chat_message(app: AppHandle, id: i64, content: String) -> Result<ChatMessage, String> {
    with_chat_store(&app, |dir| update_message(dir, id, &content))?
        .ok_or_else(|| format!("消息不存在: {}", id))
}

#[tauri::command]
pub fn delete_chat_message(app: AppHandle, id: i64) -> Result<(), String> {
    if with_chat_store(&app, |dir| remove_message(dir, id))? {
        Ok(())
    } else {
        Err(format!("消息不存在: {}", id))
    }
}

/// 收藏 / 取消收藏消息；返回收藏后的消息
#[tauri::command]
pub fn set_chat_message_favorite(
    app: AppHandle,
    id: i64,
    favorited: bool,
) -> Result<ChatMessage, String> {
    with_chat_store(&app, |dir| set_message_favorite(dir, id, favorited))?
        .ok_or_else(|| format!("消息不存在: {}", id))
}

/// 搜索会话消息（正文或文件名），可按会话集合与创建时间范围收窄（时间戳为 Unix 毫秒，含端点）
#[tauri::command]
pub fn search_chat_messages(
    app: AppHandle,
    query: String,
    session_ids: Vec<i64>,
    created_after_ms: Option<i64>,
    created_before_ms: Option<i64>,
) -> Result<ChatMessageSearchResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(ChatMessageSearchResult { matches: Vec::new(), truncated: false });
    }
    with_chat_store(&app, |dir| {
        search_messages(dir, query, &session_ids, created_after_ms, created_before_ms)
    })
}

/// 发送文件：只做一次 stat 校验并**记录其本地路径**，不复制内容。
///
/// 复制一份既慢又占空间，且会让「发送后原文件更新」看起来没生效；
/// 打开时直接用原路径（见前端 openChatFile），所以这里只保证路径当下存在。
#[tauri::command]
pub fn add_chat_file_message(
    app: AppHandle,
    source_path: String,
    session_id: i64,
    role: Option<String>,
    content: Option<String>,
) -> Result<ChatMessage, String> {
    let path = Path::new(&source_path);
    let metadata = fs::metadata(path).map_err(|e| format!("文件不存在或不可访问: {}", e))?;
    if metadata.is_dir() {
        return Err("暂不支持发送文件夹，请选择文件".to_string());
    }

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| to_slash(path));

    with_chat_store(&app, |dir| {
        insert_message(
            dir,
            NewChatMessage {
                session_id,
                role,
                kind: Some("file".to_string()),
                content,
                file_name: Some(file_name),
                file_path: Some(to_slash(path)),
                file_size: Some(metadata.len() as i64),
            },
        )
    })?
    .ok_or_else(|| "会话不存在，无法发送文件".to_string())
}

/// 发送图片：把图片缓存一份到应用数据目录（asset 协议渲染缩略图需要稳定路径），
/// 再作为 `image` 消息写入。
#[tauri::command]
pub fn add_chat_image_message(
    app: AppHandle,
    source_path: String,
    session_id: i64,
    role: Option<String>,
    content: Option<String>,
) -> Result<ChatMessage, String> {
    let metadata =
        fs::metadata(&source_path).map_err(|e| format!("图片不存在或不可访问: {}", e))?;
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "图片过大（{} MB），上限 {} MB",
            metadata.len() / 1024 / 1024,
            MAX_IMAGE_BYTES / 1024 / 1024
        ));
    }

    let raw_name = Path::new(&source_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let bytes = fs::read(&source_path).map_err(|e| format!("读取图片失败: {}", e))?;
    let stored = store_image_bytes(&attachment_dir(&app)?, &bytes, &raw_name)?;

    with_chat_store(&app, |dir| {
        insert_message(
            dir,
            NewChatMessage {
                session_id,
                role,
                kind: Some("image".to_string()),
                content,
                file_name: Some(stored.name),
                file_path: Some(stored.path),
                file_size: Some(stored.size),
            },
        )
    })?
    .ok_or_else(|| "会话不存在，无法发送图片".to_string())
}

/// 发送剪贴板里的图片（base64）：直接缓存到应用数据目录并写入 `image` 消息
#[tauri::command]
pub fn add_chat_image_message_base64(
    app: AppHandle,
    data: String,
    session_id: i64,
    name: Option<String>,
    role: Option<String>,
    content: Option<String>,
) -> Result<ChatMessage, String> {
    let compact: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = STANDARD
        .decode(compact.as_bytes())
        .map_err(|e| format!("解析图片数据失败: {}", e))?;
    let raw_name = name
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("{}.{}", FALLBACK_STEM, FALLBACK_EXT));
    let stored = store_image_bytes(&attachment_dir(&app)?, &bytes, &raw_name)?;

    with_chat_store(&app, |dir| {
        insert_message(
            dir,
            NewChatMessage {
                session_id,
                role,
                kind: Some("image".to_string()),
                content,
                file_name: Some(stored.name),
                file_path: Some(stored.path),
                file_size: Some(stored.size),
            },
        )
    })?
    .ok_or_else(|| "会话不存在，无法发送图片".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static FIXTURE_SEQ: AtomicU64 = AtomicU64::new(0);

    /// 临时目录（并行测试需 pid + 线程 + 序列号隔离）
    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "oops-chat-test-{}-{}-{:?}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
            std::thread::current().id(),
            FIXTURE_SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 会话存储目录就是临时目录本身（测试里不经过 AppHandle）
    fn store() -> PathBuf {
        temp_dir()
    }

    fn text_message(session_id: i64, content: &str) -> NewChatMessage {
        NewChatMessage {
            session_id,
            role: None,
            kind: None,
            content: Some(content.to_string()),
            file_name: None,
            file_path: None,
            file_size: None,
        }
    }

    fn read_jsonl(dir: &Path, session_id: i64) -> Vec<String> {
        fs::read_to_string(session_file_path(dir, session_id))
            .unwrap()
            .lines()
            .map(|line| line.to_string())
            .collect()
    }

    #[test]
    fn sessions_list_newest_edit_first() {
        let dir = store();
        let first = insert_session(&dir, "甲").unwrap();
        let second = insert_session(&dir, "乙").unwrap();

        insert_message(&dir, text_message(first.id, "最新")).unwrap();

        let sessions = list_sessions(&dir).unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].id, first.id, "最后被编辑的会话排最前");
        assert_eq!(sessions[1].id, second.id);
        assert_eq!(sessions[0].last_message, "最新");
        assert_eq!(sessions[0].message_count, 1);
        assert_eq!(sessions[1].last_message, "");
        assert_eq!(sessions[1].message_count, 0);
        assert_eq!(sessions[0].created_at, first.created_at, "创建时间应保留");
        assert!(sessions[0].updated_at > sessions[0].created_at, "最近编辑时间应前进");
        assert_eq!(sessions[1].created_at, sessions[1].updated_at, "无消息时两者相同");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn insert_message_bumps_session_and_defaults() {
        let dir = store();
        let session = insert_session(&dir, "会话").unwrap();
        let created = session.updated_at.clone();

        let message = insert_message(
            &dir,
            NewChatMessage {
                session_id: session.id,
                role: Some("other".into()),
                kind: Some("image".into()),
                content: None,
                file_name: Some("a-1234abcd.png".into()),
                file_path: Some("C:/tmp/a-1234abcd.png".into()),
                file_size: Some(2048),
            },
        )
        .unwrap()
        .expect("会话存在时应插入成功");

        assert_eq!(message.role, "other");
        assert_eq!(message.kind, "image");
        assert_eq!(message.content, "");
        assert_eq!(message.file_size, 2048);
        assert!(!message.edited);
        assert_eq!(message.created_at, message.updated_at);

        let reloaded = read_session(&dir, session.id).unwrap().unwrap();
        assert!(
            reloaded.updated_at > created,
            "发送消息应推进最近编辑时间: {} -> {}",
            created,
            reloaded.updated_at
        );
        assert_eq!(reloaded.last_message, "a-1234abcd.png", "非文字消息预览取文件名");
        assert_eq!(reloaded.message_count, 1);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unknown_kind_and_role_fall_back_to_text_me() {
        let dir = store();
        let session = insert_session(&dir, "会话").unwrap();
        let message = insert_message(
            &dir,
            NewChatMessage {
                session_id: session.id,
                role: Some("robot".into()),
                kind: Some("video".into()),
                content: Some("你好".into()),
                file_name: None,
                file_path: None,
                file_size: None,
            },
        )
        .unwrap()
        .unwrap();

        assert_eq!(message.role, "me");
        assert_eq!(message.kind, "text");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn message_and_session_reject_missing_targets() {
        let dir = store();
        assert!(insert_message(&dir, text_message(999, "无会话")).unwrap().is_none());
        assert!(update_message(&dir, 999, "x").unwrap().is_none());
        assert!(!remove_message(&dir, 999).unwrap());
        assert!(!remove_session(&dir, 999).unwrap());
        assert!(rename_session(&dir, 999, "x").unwrap().is_none());
        assert!(read_session(&dir, 999).unwrap().is_none());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn editing_message_keeps_created_at_and_marks_edited() {
        let dir = store();
        let session = insert_session(&dir, "会话").unwrap();
        let message = insert_message(&dir, text_message(session.id, "原文")).unwrap().unwrap();

        let edited = update_message(&dir, message.id, "改后").unwrap().unwrap();

        assert_eq!(edited.content, "改后");
        assert!(edited.edited, "编辑后应打上已编辑标记");
        assert_eq!(edited.created_at, message.created_at, "创建时间不变");
        assert!(edited.updated_at > message.updated_at, "编辑时间前进");
        assert_eq!(edited.id, message.id);

        let session_after = read_session(&dir, session.id).unwrap().unwrap();
        assert!(session_after.updated_at > message.updated_at);
        assert_eq!(list_sessions(&dir).unwrap()[0].last_message, "改后");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn favoriting_message_only_changes_the_flag() {
        let dir = store();
        let session = insert_session(&dir, "会话").unwrap();
        let message = insert_message(&dir, text_message(session.id, "原文")).unwrap().unwrap();
        let session_after_insert = read_session(&dir, session.id).unwrap().unwrap();
        assert!(!message.favorited, "新消息默认未收藏");

        let starred = set_message_favorite(&dir, message.id, true).unwrap().unwrap();

        assert!(starred.favorited, "收藏后标记应为真");
        assert_eq!(starred.updated_at, message.updated_at, "收藏不写编辑时间");
        assert!(!starred.edited, "收藏不算已编辑");
        assert_eq!(
            read_session(&dir, session.id).unwrap().unwrap().updated_at,
            session_after_insert.updated_at,
            "收藏不推进会话的最近编辑时间"
        );
        let (_, file, index) = locate_message(&dir, message.id).unwrap().unwrap();
        assert!(file.messages[index].favorited, "重新读取仍是收藏态");

        let unstarred = set_message_favorite(&dir, message.id, false).unwrap().unwrap();
        assert!(!unstarred.favorited, "取消收藏后标记应为假");
        assert!(set_message_favorite(&dir, 9999, true).unwrap().is_none(), "消息不存在时返回 None");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn messages_are_scoped_to_their_session() {
        let dir = store();
        let a = insert_session(&dir, "甲").unwrap();
        let b = insert_session(&dir, "乙").unwrap();
        insert_message(&dir, text_message(a.id, "甲的1")).unwrap();
        insert_message(&dir, text_message(b.id, "乙的1")).unwrap();
        let third = insert_message(&dir, text_message(a.id, "甲的2")).unwrap().unwrap();

        let a_messages = load_session_file(&session_file_path(&dir, a.id)).unwrap().messages;
        assert_eq!(a_messages.len(), 2);
        assert_eq!(a_messages[0].content, "甲的1", "消息按插入顺序正序");
        assert_eq!(a_messages[1].content, "甲的2");
        assert!(a_messages.iter().all(|m| m.session_id == a.id));
        assert_eq!(
            load_session_file(&session_file_path(&dir, b.id)).unwrap().messages.len(),
            1
        );
        assert_eq!(third.session_id, a.id);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deleting_message_keeps_session_and_bumps_edit_time() {
        let dir = store();
        let session = insert_session(&dir, "会话").unwrap();
        let first = insert_message(&dir, text_message(session.id, "第一条")).unwrap().unwrap();
        let second = insert_message(&dir, text_message(session.id, "第二条")).unwrap().unwrap();
        let before = read_session(&dir, session.id).unwrap().unwrap();

        assert!(remove_message(&dir, first.id).unwrap());

        let after = read_session(&dir, session.id).unwrap().unwrap();
        assert_eq!(after.message_count, 1);
        let messages = load_session_file(&session_file_path(&dir, session.id)).unwrap().messages;
        assert_eq!(messages[0].id, second.id);
        assert!(after.updated_at > before.updated_at, "删除消息也应推进最近编辑时间");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn deleting_session_removes_its_messages() {
        let dir = store();
        let session = insert_session(&dir, "会话").unwrap();
        let other = insert_session(&dir, "保留").unwrap();
        insert_message(&dir, text_message(session.id, "会被删掉")).unwrap();
        insert_message(&dir, text_message(other.id, "保留的消息")).unwrap();

        assert!(remove_session(&dir, session.id).unwrap());

        assert!(list_sessions(&dir).unwrap().iter().all(|s| s.id != session.id));
        assert!(!session_file_path(&dir, session.id).exists());
        assert_eq!(
            load_session_file(&session_file_path(&dir, other.id)).unwrap().messages.len(),
            1,
            "不牵连其它会话"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn renaming_session_keeps_edit_time() {
        let dir = store();
        let session = insert_session(&dir, "旧标题").unwrap();
        insert_message(&dir, text_message(session.id, "消息")).unwrap();
        let before = read_session(&dir, session.id).unwrap().unwrap();

        let renamed = rename_session(&dir, session.id, "  新标题  ").unwrap().unwrap();

        assert_eq!(renamed.title, "新标题", "标题应去空白");
        assert_eq!(renamed.created_at, session.created_at);
        assert_eq!(renamed.updated_at, before.updated_at, "重命名不算编辑");
        assert_eq!(renamed.message_count, 1);

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 消息搜索：正文与文件名都参与匹配，预览取命中行而不是消息首行
    #[test]
    fn message_search_matches_content_and_file_name() {
        let dir = store();
        let alpha = insert_session(&dir, "甲会话").unwrap();
        let beta = insert_session(&dir, "乙会话").unwrap();
        insert_message(&dir, text_message(alpha.id, "第一行\n这里提到 报表导出 功能")).unwrap();
        insert_message(&dir, text_message(beta.id, "无关内容")).unwrap();
        insert_message(
            &dir,
            NewChatMessage {
                session_id: beta.id,
                role: Some("other".to_string()),
                kind: Some("file".to_string()),
                content: None,
                file_name: Some("报表导出说明.pdf".to_string()),
                file_path: Some("/tmp/report.pdf".to_string()),
                file_size: Some(12),
            },
        )
        .unwrap();

        let result = search_messages(&dir, "报表导出", &[], None, None).unwrap();
        assert!(!result.truncated);
        assert_eq!(result.matches.len(), 2, "matches: {:?}", result.matches);
        assert_eq!(result.matches[0].session_title, "乙会话");
        assert_eq!(result.matches[0].kind, "file");
        assert_eq!(result.matches[0].content, "报表导出说明.pdf");
        assert_eq!(result.matches[1].session_id, alpha.id);
        assert_eq!(result.matches[1].content, "这里提到 报表导出 功能", "应取命中行");
        assert_eq!(result.matches[1].role, "me");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 消息搜索可按会话集合与创建时间范围收窄（毫秒时间戳，含端点）
    #[test]
    fn message_search_scopes_session_and_time() {
        let dir = store();
        let first = insert_session(&dir, "甲").unwrap();
        let second = insert_session(&dir, "乙").unwrap();
        let third = insert_session(&dir, "丙").unwrap();
        insert_message(&dir, text_message(first.id, "关键词 A")).unwrap();
        let old = insert_message(&dir, text_message(second.id, "关键词 B")).unwrap().unwrap();
        insert_message(&dir, text_message(second.id, "关键词 C")).unwrap();
        insert_message(&dir, text_message(third.id, "关键词 D")).unwrap();

        let scoped = search_messages(&dir, "关键词", &[second.id], None, None).unwrap();
        assert_eq!(scoped.matches.len(), 2, "matches: {:?}", scoped.matches);
        assert!(scoped.matches.iter().all(|m| m.session_id == second.id));

        let multi = search_messages(&dir, "关键词", &[first.id, second.id], None, None).unwrap();
        assert_eq!(multi.matches.len(), 3, "matches: {:?}", multi.matches);
        assert!(multi.matches.iter().any(|m| m.session_id == first.id));
        assert!(multi.matches.iter().any(|m| m.session_id == second.id));
        assert!(multi.matches.iter().all(|m| m.session_id != third.id));

        // B 的创建时间挪到很久以前：按时间下界应把它过滤掉
        let path = session_file_path(&dir, second.id);
        let mut file = load_session_file(&path).unwrap();
        let index = file.messages.iter().position(|m| m.id == old.id).unwrap();
        file.messages[index].created_at = "2001-01-01T00:00:00+08:00".to_string();
        write_session_file(&path, &file.header, &file.messages).unwrap();

        let cut = parse_ms("2002-01-01T00:00:00+08:00").unwrap();
        let recent = search_messages(&dir, "关键词", &[], Some(cut), None).unwrap();
        assert_eq!(recent.matches.len(), 3, "matches: {:?}", recent.matches);
        assert!(recent.matches.iter().all(|m| m.content != "关键词 B"));

        let past = search_messages(&dir, "关键词", &[], None, Some(cut)).unwrap();
        assert_eq!(past.matches.len(), 1, "matches: {:?}", past.matches);
        assert_eq!(past.matches[0].content, "关键词 B");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 关键词按字面匹配：`%` / `_` 不是通配符
    #[test]
    fn message_search_matches_wildcards_literally() {
        let dir = store();
        let session = insert_session(&dir, "会话").unwrap();
        insert_message(&dir, text_message(session.id, "覆盖率 80%")).unwrap();
        insert_message(&dir, text_message(session.id, "纯中文内容")).unwrap();

        let percent = search_messages(&dir, "80%", &[], None, None).unwrap();
        assert_eq!(percent.matches.len(), 1, "matches: {:?}", percent.matches);
        let underscore = search_messages(&dir, "覆_率", &[], None, None).unwrap();
        assert!(underscore.matches.is_empty(), "下划线应作为字面量: {:?}", underscore.matches);

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 命中预览限长 120 字符
    #[test]
    fn message_search_preview_is_limited() {
        let dir = store();
        let session = insert_session(&dir, "长消息").unwrap();
        insert_message(
            &dir,
            text_message(session.id, &format!("前缀 关键词 {}", "x".repeat(300))),
        )
        .unwrap();

        let result = search_messages(&dir, "关键词", &[], None, None).unwrap();
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].content.chars().count(), 120);

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 命中超过上限时截断并置位 truncated
    #[test]
    fn message_search_truncates_beyond_limit() {
        let dir = store();
        let session = insert_session(&dir, "很多").unwrap();
        for index in 0..MESSAGE_SEARCH_MAX + 5 {
            insert_message(&dir, text_message(session.id, &format!("关键词 {index}"))).unwrap();
        }

        let result = search_messages(&dir, "关键词", &[], None, None).unwrap();
        assert!(result.truncated);
        assert_eq!(result.matches.len(), MESSAGE_SEARCH_MAX);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn blank_title_on_create_falls_back_to_timestamp() {
        let dir = store();
        for raw in ["", "   "] {
            let auto = insert_session(&dir, raw).unwrap().title;
            assert!(
                is_timestamp_title(&auto),
                "留空新建的标题应为时间戳，实际: {auto}"
            );
        }
        assert_eq!(insert_session(&dir, "  真标题 ").unwrap().title, "真标题");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 时间戳标题的严格形状：`2026-09-27_10-30-15`（分隔符必须落在固定位置，其余必须为数字）
    fn is_timestamp_title(title: &str) -> bool {
        let bytes = title.as_bytes();
        if bytes.len() != 19 {
            return false;
        }
        bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 | 13 | 16 => *byte == b'-',
            10 => *byte == b'_',
            _ => byte.is_ascii_digit(),
        })
    }

    #[test]
    fn blank_title_on_rename_keeps_default_instead_of_timestamp() {
        let dir = store();
        let session = insert_session(&dir, "会话").unwrap();
        assert_eq!(
            rename_session(&dir, session.id, "  ").unwrap().unwrap().title,
            "新会话"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 文件格式：首行会话头，之后一行一条消息；内容里的换行不会拆成多行
    #[test]
    fn session_file_is_an_append_only_event_log() {
        let dir = store();
        let session = insert_session(&dir, "会话").unwrap();
        insert_message(&dir, text_message(session.id, "第一行\n第二行")).unwrap();

        let lines = read_jsonl(&dir, session.id);
        assert_eq!(lines.len(), 2, "1 行 session + 1 行 message");
        let header: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(header["type"], "session");
        assert_eq!(header["id"], session.id);
        let message: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(message["type"], "message");
        assert_eq!(message["content"], "第一行\n第二行");

        // 追加一条消息：已有行逐字节不变，只多一行
        insert_message(&dir, text_message(session.id, "第三条")).unwrap();
        let after = read_jsonl(&dir, session.id);
        assert_eq!(after.len(), 3, "追加写，不重写整个文件");
        assert_eq!(&after[..2], &lines[..], "已有行必须保持原样");
        assert!(!session_file_path(&dir, session.id)
            .with_extension("jsonl.tmp")
            .exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 旧工作区 `.oops/sessions` 的会话搬进私有目录：文件与 id 状态一起走，id 不复用
    #[test]
    fn imports_legacy_workspace_sessions() {
        let legacy = store();
        let workspace = temp_dir();
        let target = workspace.join("private-sessions");

        let session = insert_session(&legacy, "旧会话").unwrap();
        insert_message(&legacy, text_message(session.id, "旧消息")).unwrap();

        let moved = import_legacy_workspace(&legacy, &target).unwrap();
        assert_eq!(moved, 1);
        assert_eq!(list_sessions(&target).unwrap().len(), 1);
        assert_eq!(
            load_session_file(&session_file_path(&target, session.id))
                .unwrap()
                .messages
                .len(),
            1
        );

        // 状态合并后新建会话继续用更大的 id
        let next = insert_session(&target, "新会话").unwrap();
        assert!(next.id > session.id);
        // 幂等：再导入不会产生重复文件
        assert_eq!(import_legacy_workspace(&legacy, &target).unwrap(), 0);

        fs::remove_dir_all(&legacy).unwrap();
        fs::remove_dir_all(&workspace).unwrap();
    }

    /// 回归：目录里混进空文件/垃圾/非会话 JSONL 时，列表和搜索都不能整体失败；
    /// 旧版“文件名即 id + 首行 header + 裸消息”的文件仍能被读出来。
    #[test]
    fn listing_skips_junk_files_and_accepts_legacy_records() {
        let dir = store();
        let session = insert_session(&dir, "正常会话").unwrap();
        insert_message(&dir, text_message(session.id, "正常消息")).unwrap();

        fs::write(dir.join("empty.jsonl"), b"").unwrap();
        fs::write(dir.join("garbage.jsonl"), b"not json\n{broken\n").unwrap();
        fs::write(dir.join("notes.jsonl"), b"{\"type\":\"something-else\"}\n").unwrap();

        let header = serde_json::json!({
            "type": "session", "id": 99, "title": "旧格式",
            "created_at": "2026-01-01T00:00:00+08:00",
            "updated_at": "2026-01-02T00:00:00+08:00"
        });
        let message = serde_json::json!({
            "id": 7, "session_id": 99, "role": "me", "kind": "text",
            "content": "旧消息", "file_name": null, "file_path": null, "file_size": 0,
            "created_at": "2026-01-02T00:00:00+08:00",
            "updated_at": "2026-01-02T00:00:00+08:00",
            "edited": false, "favorited": false
        });
        fs::write(
            dir.join("99.jsonl"),
            format!("{}\n{}\n", header, message),
        )
        .unwrap();

        let sessions = list_sessions(&dir).unwrap();
        assert_eq!(sessions.len(), 2, "垃圾文件不应变成会话: {:?}", sessions);
        let legacy = sessions
            .iter()
            .find(|item| item.id == 99)
            .expect("旧格式会话应被读出");
        assert_eq!(legacy.title, "旧格式");
        assert_eq!(legacy.message_count, 1);
        assert_eq!(legacy.last_message, "旧消息");

        let found = search_messages(&dir, "消息", &[], None, None).unwrap();
        assert_eq!(found.matches.len(), 2, "坏文件不应让搜索失败");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 导出单个会话：自动补 .jsonl，内容与原文件逐字节一致
    #[test]
    fn exports_single_session_as_jsonl() {
        let source_dir = store();
        let session = insert_session(&source_dir, "导出验证").unwrap();
        insert_message(&source_dir, text_message(session.id, "消息")).unwrap();
        let source = session_file_path(&source_dir, session.id);

        let target = temp_dir().join("backup").join("我的会话");
        let exported = export_session_file(&source, &target).unwrap();

        assert_eq!(exported.extension().and_then(|ext| ext.to_str()), Some("jsonl"));
        assert_eq!(
            fs::read_to_string(&exported).unwrap(),
            fs::read_to_string(&source).unwrap()
        );

        fs::remove_dir_all(&source_dir).unwrap();
        fs::remove_dir_all(exported.parent().unwrap().parent().unwrap()).unwrap();
    }

    /// 批量导出：每个会话一个带标题的文件，重名会话自动加序号
    #[test]
    fn exports_all_sessions_with_readable_unique_names() {
        let source_dir = store();
        let first = insert_session(&source_dir, "同名会话").unwrap();
        let second = insert_session(&source_dir, "同名会话").unwrap();
        insert_message(&source_dir, text_message(first.id, "a")).unwrap();

        let target_dir = temp_dir();
        assert_eq!(export_all_sessions_to(&source_dir, &target_dir).unwrap(), 2);

        let names: Vec<String> = fs::read_dir(&target_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names.len(), 2);
        assert!(names.iter().all(|name| name.ends_with(".jsonl")));
        assert!(
            names.iter().any(|name| name.contains(&format!("session-{}-", first.id))),
            "names: {names:?}"
        );
        assert!(
            names.iter().any(|name| name.contains(&format!("session-{}-", second.id))),
            "names: {names:?}"
        );
        assert!(export_all_sessions_to(&source_dir, &source_dir).is_err());

        fs::remove_dir_all(&source_dir).unwrap();
        fs::remove_dir_all(&target_dir).unwrap();
    }

    /// 消息 id 跨会话全局递增（编辑/删除接口只带 id）
    #[test]
    fn message_ids_are_unique_across_sessions() {
        let dir = store();
        let a = insert_session(&dir, "甲").unwrap();
        let b = insert_session(&dir, "乙").unwrap();
        let first = insert_message(&dir, text_message(a.id, "a")).unwrap().unwrap();
        let second = insert_message(&dir, text_message(b.id, "b")).unwrap().unwrap();
        assert!(second.id > first.id);

        // 删除后不复用 id
        remove_message(&dir, second.id).unwrap();
        let third = insert_message(&dir, text_message(b.id, "c")).unwrap().unwrap();
        assert!(third.id > second.id);

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 旧库迁移：会话/消息/收藏状态都写进 JSONL，重复执行不覆盖
    #[test]
    fn migrates_legacy_sqlite_to_jsonl() {
        let conn = Connection::open_in_memory().unwrap();
        init_chat_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO chat_sessions (id, title, created_at, updated_at)
             VALUES (7, '旧会话', '2026-01-01T00:00:00+08:00', '2026-01-02T00:00:00+08:00')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_messages
                (id, session_id, role, kind, content, file_name, file_path, file_size,
                 created_at, updated_at, edited, favorited)
             VALUES (42, 7, 'me', 'text', '旧消息', NULL, NULL, 0,
                     '2026-01-01T00:00:00+08:00', '2026-01-01T00:00:00+08:00', 1, 1)",
            [],
        )
        .unwrap();

        let dir = store();
        migrate_chat_to_jsonl_in(&dir, &conn).unwrap();

        let file = load_session_file(&session_file_path(&dir, 7)).unwrap();
        assert_eq!(file.header.title, "旧会话");
        assert_eq!(file.header.message_count, 1);
        assert_eq!(file.messages.len(), 1);
        assert_eq!(file.messages[0].id, 42);
        assert!(file.messages[0].edited);
        assert!(file.messages[0].favorited);

        // 幂等：再跑一次不报错，也不覆盖已有文件
        migrate_chat_to_jsonl_in(&dir, &conn).unwrap();
        assert_eq!(list_sessions(&dir).unwrap().len(), 1);

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 很旧的库没有 favorited 列：init_chat_schema 补列后迁移不报错
    #[test]
    fn migrates_legacy_schema_without_favorited_column() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE chat_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE TABLE chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL,
                role TEXT NOT NULL DEFAULT 'me', kind TEXT NOT NULL DEFAULT 'text',
                content TEXT NOT NULL DEFAULT '', file_name TEXT, file_path TEXT,
                file_size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, edited INTEGER NOT NULL DEFAULT 0
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES (1, '旧会话', 't', 't')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_messages (session_id, role, kind, content, created_at, updated_at, edited)
             VALUES (1, 'me', 'text', '旧消息', 't', 't', 0)",
            [],
        )
        .unwrap();

        init_chat_schema(&conn).unwrap();
        let dir = store();
        migrate_chat_to_jsonl_in(&dir, &conn).unwrap();

        let file = load_session_file(&session_file_path(&dir, 1)).unwrap();
        assert_eq!(file.messages.len(), 1, "迁移不应丢旧数据");
        assert!(!file.messages[0].favorited, "旧消息默认未收藏");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 图片：同内容只缓存一份，路径为正斜杠，可被 asset 协议使用
    #[test]
    fn image_same_content_is_stored_once() {
        let dir = temp_dir();

        let first = store_image_bytes(&dir, b"PNG-BYTES", "shot.png").unwrap();
        let second = store_image_bytes(&dir, b"PNG-BYTES", "shot.png").unwrap();

        assert_eq!(first.name, second.name);
        assert_eq!(first.path, second.path);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "重复内容不应产生第二个文件");
        assert!(first.name.starts_with("shot-"), "name: {}", first.name);
        assert!(first.name.ends_with(".png"), "name: {}", first.name);
        assert_eq!(first.size, 9);
        assert!(!first.path.contains('\\'), "path: {}", first.path);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn image_different_content_creates_second_file() {
        let dir = temp_dir();
        let a = store_image_bytes(&dir, b"AAA", "image.png").unwrap();
        let b = store_image_bytes(&dir, b"BBB", "image.png").unwrap();

        assert_ne!(a.name, b.name);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn image_keeps_readable_name_for_chinese_and_rejects_empty() {
        let dir = temp_dir();
        let stored = store_image_bytes(&dir, b"X", "会议纪要.png").unwrap();
        assert!(stored.name.starts_with("会议纪要-"), "name: {}", stored.name);
        assert!(stored.name.ends_with(".png"), "name: {}", stored.name);

        let plain = store_image_bytes(&dir, b"Y", "截图").unwrap();
        assert!(plain.name.ends_with(".png"), "name: {}", plain.name);
        assert!(store_image_bytes(&dir, b"", "empty.png").is_err());

        let again =
            store_image_bytes(&dir, b"X", &Path::new(&stored.path).to_string_lossy()).unwrap();
        assert_eq!(again.name, stored.name);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tampered_image_is_not_treated_as_same_content() {
        let dir = temp_dir();
        let original = store_image_bytes(&dir, b"ORIGINAL", "shot.png").unwrap();
        fs::write(
            dir.join(&original.name),
            b"EDITED-BY-USER-LONGER-THAN-BEFORE",
        )
        .unwrap();

        let again = store_image_bytes(&dir, b"ORIGINAL", "shot.png").unwrap();

        assert_ne!(again.name, original.name, "被改过的文件不应复用");
        assert_eq!(
            fs::read(dir.join(&original.name)).unwrap(),
            b"EDITED-BY-USER-LONGER-THAN-BEFORE",
            "用户改过的文件保持原样"
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 发送文件：只记录路径，不复制内容、不读入内存，且大小来自 stat
    #[test]
    fn file_message_records_source_path_without_copying() {
        let dir = store();
        let source = dir.join("季度报告.txt");
        let payload = vec![b'x'; 8 * 1024 * 1024];
        fs::write(&source, &payload).unwrap();
        let before = fs::read_dir(&dir).unwrap().count();

        let session = insert_session(&dir, "会话").unwrap();
        let source_slash = to_slash(&source);
        let metadata = fs::metadata(&source).unwrap();
        let message = insert_message(
            &dir,
            NewChatMessage {
                session_id: session.id,
                role: None,
                kind: Some("file".to_string()),
                content: None,
                file_name: Some("季度报告.txt".to_string()),
                file_path: Some(source_slash.clone()),
                file_size: Some(metadata.len() as i64),
            },
        )
        .unwrap()
        .unwrap();

        assert_eq!(message.kind, "file");
        assert_eq!(message.file_path.as_deref(), Some(source_slash.as_str()));
        assert_eq!(message.file_name.as_deref(), Some("季度报告.txt"));
        assert_eq!(message.file_size, payload.len() as i64);
        assert_eq!(fs::read(&source).unwrap().len(), payload.len());
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            before + 2,
            "会话文件 + 自增状态文件，不应复制出副本"
        );
        assert_eq!(list_sessions(&dir).unwrap()[0].last_message, "季度报告.txt");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 发送的文件被移动/删除后，记录仍在（打开时会由前端提示），不静默改数据
    #[test]
    fn file_message_survives_source_removal() {
        let dir = store();
        let source = dir.join("临时.txt");
        fs::write(&source, b"data").unwrap();
        let session = insert_session(&dir, "会话").unwrap();

        let message = insert_message(
            &dir,
            NewChatMessage {
                session_id: session.id,
                role: None,
                kind: Some("file".to_string()),
                content: None,
                file_name: Some("临时.txt".to_string()),
                file_path: Some(to_slash(&source)),
                file_size: Some(4),
            },
        )
        .unwrap()
        .unwrap();

        fs::remove_file(&source).unwrap();

        let (_, file, index) = locate_message(&dir, message.id).unwrap().unwrap();
        assert_eq!(file.messages[index].file_path, message.file_path, "路径记录保持不变");
        assert_eq!(file.messages[index].kind, "file");

        fs::remove_dir_all(&dir).unwrap();
    }
}
