//! 会话面板数据层：会话 / 消息 CRUD 与聊天图片附件落盘。
//!
//! - 会话按「最近编辑时间」(updated_at) 倒序展示，消息按写入顺序正序展示；
//! - 消息文本可编辑，编辑后 `edited = 1` 且 `updated_at` 前进，`created_at` 保持不变；
//! - 发送的**文件**只记录其本地路径（不复制、不读内容），始终指回原文件；
//!   只有**图片**需要落盘一份副本——webview 要通过 asset 协议渲染缩略图，
//!   而原始文件可能随时被移动/删除，缓存一份才能保证历史消息里的图仍在。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::db::with_db;

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
// ── 会话 CRUD ──────────────────────────────────────────────────

/// 会话列表查询：附带消息条数与最近一条消息预览
const SESSION_SELECT: &str = "SELECT s.id, s.title, s.created_at, s.updated_at,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id),
        COALESCE((
            SELECT CASE m.kind WHEN 'text' THEN m.content ELSE COALESCE(m.file_name, '') END
            FROM chat_messages m WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1
        ), '')";

fn map_session(row: &rusqlite::Row<'_>) -> SqlResult<ChatSession> {
    Ok(ChatSession {
        id: row.get(0)?,
        title: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        message_count: row.get(4)?,
        last_message: row.get(5)?,
    })
}

fn list_sessions(conn: &Connection) -> SqlResult<Vec<ChatSession>> {
    let sql = format!(
        "{} FROM chat_sessions s ORDER BY s.updated_at DESC, s.id DESC",
        SESSION_SELECT
    );
    let mut stmt = conn.prepare(&sql)?;
    let sessions = stmt
        .query_map([], map_session)?
        .collect::<SqlResult<Vec<ChatSession>>>()?;
    Ok(sessions)
}

fn read_session(conn: &Connection, id: i64) -> SqlResult<Option<ChatSession>> {
    let sql = format!("{} FROM chat_sessions s WHERE s.id = ?1", SESSION_SELECT);
    conn.query_row(&sql, params![id], map_session).optional()
}

fn insert_session(conn: &Connection, title: &str) -> SqlResult<ChatSession> {
    let title = new_session_title(title);
    let now = now();
    conn.execute(
        "INSERT INTO chat_sessions (title, created_at, updated_at) VALUES (?1, ?2, ?2)",
        params![title, now],
    )?;

    Ok(ChatSession {
        id: conn.last_insert_rowid(),
        title,
        created_at: now.clone(),
        updated_at: now,
        message_count: 0,
        last_message: String::new(),
    })
}

fn rename_session(conn: &Connection, id: i64, title: &str) -> SqlResult<Option<ChatSession>> {
    // 重命名属于元数据变更，不推进 updated_at（「最近编辑时间」只反映消息变化）
    let affected = conn.execute(
        "UPDATE chat_sessions SET title = ?1 WHERE id = ?2",
        params![normalized_title(title), id],
    )?;
    if affected == 0 {
        return Ok(None);
    }
    read_session(conn, id)
}

fn remove_session(conn: &Connection, id: i64) -> SqlResult<bool> {
    // 不依赖 PRAGMA foreign_keys（默认关闭），显式清理消息
    conn.execute("DELETE FROM chat_messages WHERE session_id = ?1", params![id])?;
    let affected = conn.execute("DELETE FROM chat_sessions WHERE id = ?1", params![id])?;
    Ok(affected > 0)
}

/// 推进会话的最近编辑时间
fn touch_session(conn: &Connection, id: i64) -> SqlResult<()> {
    conn.execute(
        "UPDATE chat_sessions SET updated_at = ?1 WHERE id = ?2",
        params![now(), id],
    )?;
    Ok(())
}

// ── 消息 CRUD ──────────────────────────────────────────────────

const MESSAGE_SELECT: &str = "SELECT id, session_id, role, kind, content, file_name, file_path, file_size,
        created_at, updated_at, edited, favorited FROM chat_messages";

fn map_message(row: &rusqlite::Row<'_>) -> SqlResult<ChatMessage> {
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
}

fn list_messages(conn: &Connection, session_id: i64) -> SqlResult<Vec<ChatMessage>> {
    let sql = format!(
        "{} WHERE session_id = ?1 ORDER BY id ASC",
        MESSAGE_SELECT
    );
    let mut stmt = conn.prepare(&sql)?;
    let messages = stmt
        .query_map(params![session_id], map_message)?
        .collect::<SqlResult<Vec<ChatMessage>>>()?;
    Ok(messages)
}

fn read_message(conn: &Connection, id: i64) -> SqlResult<Option<ChatMessage>> {
    let sql = format!("{} WHERE id = ?1", MESSAGE_SELECT);
    conn.query_row(&sql, params![id], map_message).optional()
}

/// 插入消息并推进所属会话的最近编辑时间；会话不存在时返回 None
fn insert_message(conn: &Connection, input: NewChatMessage) -> SqlResult<Option<ChatMessage>> {
    if read_session(conn, input.session_id)?.is_none() {
        return Ok(None);
    }

    let now = now();
    conn.execute(
        "INSERT INTO chat_messages
            (session_id, role, kind, content, file_name, file_path, file_size, created_at, updated_at, edited)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 0)",
        params![
            input.session_id,
            normalized_role(input.role.as_deref()),
            normalized_kind(input.kind.as_deref()),
            input.content.unwrap_or_default(),
            input.file_name,
            input.file_path,
            input.file_size.unwrap_or(0),
            now,
        ],
    )?;

    touch_session(conn, input.session_id)?;
    read_message(conn, conn.last_insert_rowid())
}

/// 编辑消息文字；消息不存在时返回 None
fn update_message(conn: &Connection, id: i64, content: &str) -> SqlResult<Option<ChatMessage>> {
    let Some(existing) = read_message(conn, id)? else {
        return Ok(None);
    };

    conn.execute(
        "UPDATE chat_messages SET content = ?1, updated_at = ?2, edited = 1 WHERE id = ?3",
        params![content, now(), id],
    )?;
    touch_session(conn, existing.session_id)?;
    read_message(conn, id)
}

/// 删除消息并推进所属会话的最近编辑时间；返回是否存在该消息
fn remove_message(conn: &Connection, id: i64) -> SqlResult<bool> {
    let Some(existing) = read_message(conn, id)? else {
        return Ok(false);
    };

    conn.execute("DELETE FROM chat_messages WHERE id = ?1", params![id])?;
    touch_session(conn, existing.session_id)?;
    Ok(true)
}

/// 收藏 / 取消收藏消息；消息不存在时返回 None。
///
/// 只改展示标记：既不写 `updated_at`（否则会显示成"已编辑"），
/// 也不推进会话的最近编辑时间（收藏不是内容变更，不该让会话在列表里往前走）。
fn set_message_favorite(conn: &Connection, id: i64, favorited: bool) -> SqlResult<Option<ChatMessage>> {
    if read_message(conn, id)?.is_none() {
        return Ok(None);
    }

    conn.execute(
        "UPDATE chat_messages SET favorited = ?1 WHERE id = ?2",
        params![favorited as i64, id],
    )?;
    read_message(conn, id)
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
pub fn get_chat_sessions() -> Result<Vec<ChatSession>, String> {
    with_db(list_sessions)
}

/// 新建会话；标题缺省为时间戳（与前端「新建文件」同名口径）
#[tauri::command]
pub fn add_chat_session(title: Option<String>) -> Result<ChatSession, String> {
    with_db(|conn| insert_session(conn, title.as_deref().unwrap_or("")))
}

#[tauri::command]
pub fn rename_chat_session(id: i64, title: String) -> Result<ChatSession, String> {
    with_db(|conn| rename_session(conn, id, &title))?
        .ok_or_else(|| format!("会话不存在: {}", id))
}

#[tauri::command]
pub fn delete_chat_session(id: i64) -> Result<(), String> {
    if with_db(|conn| remove_session(conn, id))? {
        Ok(())
    } else {
        Err(format!("会话不存在: {}", id))
    }
}

#[tauri::command]
pub fn get_chat_messages(session_id: i64) -> Result<Vec<ChatMessage>, String> {
    with_db(|conn| list_messages(conn, session_id))
}

#[tauri::command]
pub fn add_chat_message(message: NewChatMessage) -> Result<ChatMessage, String> {
    with_db(|conn| insert_message(conn, message))?
        .ok_or_else(|| "会话不存在，无法发送消息".to_string())
}

#[tauri::command]
pub fn update_chat_message(id: i64, content: String) -> Result<ChatMessage, String> {
    with_db(|conn| update_message(conn, id, &content))?
        .ok_or_else(|| format!("消息不存在: {}", id))
}

#[tauri::command]
pub fn delete_chat_message(id: i64) -> Result<(), String> {
    if with_db(|conn| remove_message(conn, id))? {
        Ok(())
    } else {
        Err(format!("消息不存在: {}", id))
    }
}

/// 收藏 / 取消收藏消息；返回收藏后的消息
#[tauri::command]
pub fn set_chat_message_favorite(id: i64, favorited: bool) -> Result<ChatMessage, String> {
    with_db(|conn| set_message_favorite(conn, id, favorited))?
        .ok_or_else(|| format!("消息不存在: {}", id))
}

/// 发送文件：只做一次 stat 校验并**记录其本地路径**，不复制内容。
///
/// 复制一份既慢又占空间，且会让「发送后原文件更新」看起来没生效；
/// 打开时直接用原路径（见前端 openChatFile），所以这里只保证路径当下存在。
#[tauri::command]
pub fn add_chat_file_message(
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

    with_db(|conn| {
        insert_message(
            conn,
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

    with_db(|conn| {
        insert_message(
            conn,
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

    with_db(|conn| {
        insert_message(
            conn,
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

    /// 内存库 + 建表
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_chat_schema(&conn).unwrap();
        conn
    }

    /// 附件落盘用的临时目录（并行测试需 pid + 线程 + 序列号隔离）
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

    #[test]
    fn sessions_list_newest_edit_first() {
        let conn = db();
        let first = insert_session(&conn, "甲").unwrap();
        let second = insert_session(&conn, "乙").unwrap();

        insert_message(&conn, text_message(first.id, "最新")).unwrap();

        let sessions = list_sessions(&conn).unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].id, first.id, "最后被编辑的会话排最前");
        assert_eq!(sessions[1].id, second.id);
        assert_eq!(sessions[0].last_message, "最新");
        assert_eq!(sessions[0].message_count, 1);
        assert_eq!(sessions[1].last_message, "");
        assert_eq!(sessions[1].message_count, 0);
        // 创建时间不动，最近编辑时间随消息前进
        assert_eq!(sessions[0].created_at, first.created_at, "创建时间应保留");
        assert!(sessions[0].updated_at > sessions[0].created_at, "最近编辑时间应前进");
        assert_eq!(sessions[1].created_at, sessions[1].updated_at, "无消息时两者相同");
    }

    #[test]
    fn insert_message_bumps_session_and_defaults() {
        let conn = db();
        let session = insert_session(&conn, "会话").unwrap();
        let created = session.updated_at.clone();

        let message = insert_message(
            &conn,
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

        let reloaded = read_session(&conn, session.id).unwrap().unwrap();
        assert!(
            reloaded.updated_at > created,
            "发送消息应推进最近编辑时间: {} -> {}",
            created,
            reloaded.updated_at
        );
        assert_eq!(reloaded.last_message, "a-1234abcd.png", "非文字消息预览取文件名");
        assert_eq!(reloaded.message_count, 1);
    }

    #[test]
    fn unknown_kind_and_role_fall_back_to_text_me() {
        let conn = db();
        let session = insert_session(&conn, "会话").unwrap();
        let message = insert_message(
            &conn,
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
    }

    #[test]
    fn message_and_session_reject_missing_targets() {
        let conn = db();
        assert!(insert_message(&conn, text_message(999, "无会话")).unwrap().is_none());
        assert!(update_message(&conn, 999, "x").unwrap().is_none());
        assert!(!remove_message(&conn, 999).unwrap());
        assert!(!remove_session(&conn, 999).unwrap());
        assert!(rename_session(&conn, 999, "x").unwrap().is_none());
    }

    #[test]
    fn editing_message_keeps_created_at_and_marks_edited() {
        let conn = db();
        let session = insert_session(&conn, "会话").unwrap();
        let message = insert_message(&conn, text_message(session.id, "原文")).unwrap().unwrap();

        let edited = update_message(&conn, message.id, "改后").unwrap().unwrap();

        assert_eq!(edited.content, "改后");
        assert!(edited.edited, "编辑后应打上已编辑标记");
        assert_eq!(edited.created_at, message.created_at, "创建时间不变");
        assert!(edited.updated_at > message.updated_at, "编辑时间前进");
        assert_eq!(edited.id, message.id);

        // 会话的最近编辑时间也随之推进
        let session_after = read_session(&conn, session.id).unwrap().unwrap();
        assert!(session_after.updated_at > message.updated_at);
        assert_eq!(list_sessions(&conn).unwrap()[0].last_message, "改后");
    }

    #[test]
    fn legacy_database_gains_favorited_column() {
        let conn = Connection::open_in_memory().unwrap();
        // 旧库结构：chat_messages 没有 favorited 列（CREATE TABLE IF NOT EXISTS 不会补列）
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

        let messages = list_messages(&conn, 1).unwrap();
        assert_eq!(messages.len(), 1, "迁移不应丢旧数据");
        assert!(!messages[0].favorited, "旧消息补列后默认未收藏");
        assert!(set_message_favorite(&conn, messages[0].id, true).unwrap().unwrap().favorited);
    }

    #[test]
    fn favoriting_message_only_changes_the_flag() {
        let conn = db();
        let session = insert_session(&conn, "会话").unwrap();
        let message = insert_message(&conn, text_message(session.id, "原文")).unwrap().unwrap();
        // 基线取「插入消息之后」的会话状态：insert_message 本身会推进会话的最近编辑时间
        let session_after_insert = read_session(&conn, session.id).unwrap().unwrap();
        assert!(!message.favorited, "新消息默认未收藏");

        let starred = set_message_favorite(&conn, message.id, true).unwrap().unwrap();

        assert!(starred.favorited, "收藏后标记应为真");
        assert_eq!(starred.updated_at, message.updated_at, "收藏不写编辑时间");
        assert!(!starred.edited, "收藏不算已编辑");
        assert_eq!(
            read_session(&conn, session.id).unwrap().unwrap().updated_at,
            session_after_insert.updated_at,
            "收藏不推进会话的最近编辑时间"
        );
        let listed = list_messages(&conn, session.id).unwrap();
        assert!(listed[0].favorited, "重新查询仍是收藏态");

        let unstarred = set_message_favorite(&conn, message.id, false).unwrap().unwrap();
        assert!(!unstarred.favorited, "取消收藏后标记应为假");
        assert!(set_message_favorite(&conn, 9999, true).unwrap().is_none(), "消息不存在时返回 None");
    }

    #[test]
    fn messages_are_scoped_to_their_session() {
        let conn = db();
        let a = insert_session(&conn, "甲").unwrap();
        let b = insert_session(&conn, "乙").unwrap();
        insert_message(&conn, text_message(a.id, "甲的1")).unwrap();
        insert_message(&conn, text_message(b.id, "乙的1")).unwrap();
        let third = insert_message(&conn, text_message(a.id, "甲的2")).unwrap().unwrap();

        let a_messages = list_messages(&conn, a.id).unwrap();
        assert_eq!(a_messages.len(), 2);
        assert_eq!(a_messages[0].content, "甲的1", "消息按插入顺序正序");
        assert_eq!(a_messages[1].content, "甲的2");
        assert!(a_messages.iter().all(|m| m.session_id == a.id));
        assert_eq!(list_messages(&conn, b.id).unwrap().len(), 1);
        assert_eq!(third.session_id, a.id);
    }

    #[test]
    fn deleting_message_keeps_session_and_bumps_edit_time() {
        let conn = db();
        let session = insert_session(&conn, "会话").unwrap();
        let first = insert_message(&conn, text_message(session.id, "第一条")).unwrap().unwrap();
        let second = insert_message(&conn, text_message(session.id, "第二条")).unwrap().unwrap();
        let before = read_session(&conn, session.id).unwrap().unwrap();

        assert!(remove_message(&conn, first.id).unwrap());

        let after = read_session(&conn, session.id).unwrap().unwrap();
        assert_eq!(after.message_count, 1);
        assert_eq!(list_messages(&conn, session.id).unwrap()[0].id, second.id);
        assert!(after.updated_at > before.updated_at, "删除消息也应推进最近编辑时间");
    }

    #[test]
    fn deleting_session_removes_its_messages() {
        let conn = db();
        let session = insert_session(&conn, "会话").unwrap();
        let other = insert_session(&conn, "保留").unwrap();
        insert_message(&conn, text_message(session.id, "会被删掉")).unwrap();
        insert_message(&conn, text_message(other.id, "保留的消息")).unwrap();

        assert!(remove_session(&conn, session.id).unwrap());

        assert!(list_sessions(&conn).unwrap().iter().all(|s| s.id != session.id));
        assert!(list_messages(&conn, session.id).unwrap().is_empty());
        assert_eq!(list_messages(&conn, other.id).unwrap().len(), 1, "不牵连其它会话");
    }

    #[test]
    fn renaming_session_keeps_edit_time() {
        let conn = db();
        let session = insert_session(&conn, "旧标题").unwrap();
        insert_message(&conn, text_message(session.id, "消息")).unwrap();
        let before = read_session(&conn, session.id).unwrap().unwrap();

        let renamed = rename_session(&conn, session.id, "  新标题  ").unwrap().unwrap();

        assert_eq!(renamed.title, "新标题", "标题应去空白");
        assert_eq!(renamed.created_at, session.created_at);
        assert_eq!(renamed.updated_at, before.updated_at, "重命名不算编辑");
        assert_eq!(renamed.message_count, 1);
    }

    #[test]
    fn blank_title_on_create_falls_back_to_timestamp() {
        let conn = db();
        // 新建：留空（含纯空白）→ 时间戳，形状为 YYYY-MM-DD_HH-MM-SS（不含冒号，可作文件名）
        for raw in ["", "   "] {
            let auto = insert_session(&conn, raw).unwrap().title;
            assert!(
                is_timestamp_title(&auto),
                "留空新建的标题应为时间戳，实际: {auto}"
            );
        }
        assert_eq!(insert_session(&conn, "  真标题 ").unwrap().title, "真标题");
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
        let conn = db();
        let session = insert_session(&conn, "会话").unwrap();
        // 重命名留空不是「新建」，不该被静默改成时间戳
        assert_eq!(
            rename_session(&conn, session.id, "  ").unwrap().unwrap().title,
            "新会话"
        );
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

        // 无扩展名时回退 png；空内容被拒绝
        let plain = store_image_bytes(&dir, b"Y", "截图").unwrap();
        assert!(plain.name.ends_with(".png"), "name: {}", plain.name);
        assert!(store_image_bytes(&dir, b"", "empty.png").is_err());

        // 重复发送同一份已落盘图片时文件名保持稳定（不叠加哈希）
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
        let dir = temp_dir();
        let source = dir.join("季度报告.txt");
        // 故意造一个大文件：若实现仍整块读入内存，这个用例会明显变慢而非失败
        let payload = vec![b'x'; 8 * 1024 * 1024];
        fs::write(&source, &payload).unwrap();
        let before = fs::read_dir(&dir).unwrap().count();

        let conn = db();
        let session = insert_session(&conn, "会话").unwrap();
        let source_slash = to_slash(&source);

        // 走与命令相同的落库逻辑（命令层只多一次 stat 校验）
        let metadata = fs::metadata(&source).unwrap();
        let message = insert_message(
            &conn,
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
        // 原文件未被改动，目录里也没多出副本
        assert_eq!(fs::read(&source).unwrap().len(), payload.len());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), before, "不应复制出副本");
        // 会话预览显示文件名而非路径
        assert_eq!(list_sessions(&conn).unwrap()[0].last_message, "季度报告.txt");

        fs::remove_dir_all(&dir).unwrap();
    }

    /// 发送的文件被移动/删除后，记录仍在（打开时会由前端提示），不静默改数据
    #[test]
    fn file_message_survives_source_removal() {
        let dir = temp_dir();
        let source = dir.join("临时.txt");
        fs::write(&source, b"data").unwrap();
        let conn = db();
        let session = insert_session(&conn, "会话").unwrap();

        let message = insert_message(
            &conn,
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

        let reloaded = read_message(&conn, message.id).unwrap().unwrap();
        assert_eq!(reloaded.file_path, message.file_path, "路径记录保持不变");
        assert_eq!(reloaded.kind, "file");

        fs::remove_dir_all(&dir).unwrap();
    }
}
