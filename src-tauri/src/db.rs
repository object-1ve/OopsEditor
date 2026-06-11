use chrono::Local;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

// ── Database path ──────────────────────────────────────────────

fn get_db_path(app: &AppHandle) -> PathBuf {
    let app_dir = app.path().app_data_dir().expect("无法获取应用数据目录");
    std::fs::create_dir_all(&app_dir).ok();
    app_dir.join("projects.db")
}

// ── Global connection ──────────────────────────────────────────

static DB: Lazy<Mutex<Option<Connection>>> = Lazy::new(|| Mutex::new(None));

fn with_db<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> SqlResult<T>,
{
    let guard = DB.lock();
    let conn = guard.as_ref().ok_or_else(|| "数据库未初始化".to_string())?;
    f(conn).map_err(|e| format!("数据库操作失败: {}", e))
}

// ── Schema ─────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub description: Option<String>,
    pub tags: Option<String>,
    pub is_pinned: bool,
    pub last_opened_at: Option<String>,
    pub created_at: String,
    pub opened_count: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NewProject {
    pub name: String,
    pub path: String,
    pub description: Option<String>,
    pub tags: Option<String>,
}

// ── Tab types ──────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tab {
    pub id: i64,
    pub file_id: String,
    pub name: String,
    pub path: String,
    pub language: String,
    pub content: String,
    pub view_mode: String,
    pub is_dirty: bool,
    pub is_read_only: bool,
    pub is_preview_mode: bool,
    pub is_live_preview: bool,
    pub size: i64,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct NewTab {
    pub file_id: String,
    pub name: String,
    pub path: String,
    pub language: Option<String>,
    pub content: Option<String>,
    pub view_mode: Option<String>,
    pub is_dirty: Option<bool>,
    pub is_read_only: Option<bool>,
    pub is_preview_mode: Option<bool>,
    pub is_live_preview: Option<bool>,
    pub size: Option<i64>,
    pub sort_order: Option<i64>,
}

// ── App setting / pinned / expanded types ──────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct SettingEntry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PinnedFileRecord {
    pub id: i64,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(dead_code)]
pub struct PinnedFolderRecord {
    pub id: i64,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(dead_code)]
pub struct ExpandedFolderRecord {
    pub id: i64,
    pub path: String,
}

// ── Database initialization ────────────────────────────────────

#[tauri::command]
pub fn init_project_database(app: AppHandle) -> Result<(), String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(&db_path).map_err(|e| format!("无法打开数据库: {}", e))?;

    // 启用 WAL 模式以提升并发性能
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("设置 WAL 模式失败: {}", e))?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT NOT NULL,
            path            TEXT NOT NULL UNIQUE,
            description     TEXT,
            tags            TEXT,
            is_pinned       INTEGER NOT NULL DEFAULT 0,
            last_opened_at  TEXT,
            created_at      TEXT NOT NULL,
            opened_count    INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path);
        CREATE INDEX IF NOT EXISTS idx_projects_pinned ON projects(is_pinned);
        CREATE INDEX IF NOT EXISTS idx_projects_last_opened ON projects(last_opened_at DESC);

        CREATE TABLE IF NOT EXISTS tabs (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            file_id           TEXT NOT NULL UNIQUE,
            name              TEXT NOT NULL,
            path              TEXT NOT NULL,
            language          TEXT NOT NULL DEFAULT 'plaintext',
            content           TEXT NOT NULL DEFAULT '',
            view_mode         TEXT NOT NULL DEFAULT 'text',
            is_dirty          INTEGER NOT NULL DEFAULT 0,
            is_read_only      INTEGER NOT NULL DEFAULT 0,
            is_preview_mode   INTEGER NOT NULL DEFAULT 0,
            is_live_preview   INTEGER NOT NULL DEFAULT 0,
            size              INTEGER NOT NULL DEFAULT 0,
            sort_order        INTEGER NOT NULL DEFAULT 0,
            created_at        TEXT NOT NULL,
            updated_at        TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tabs_path ON tabs(path);
        CREATE INDEX IF NOT EXISTS idx_tabs_sort ON tabs(sort_order);

        CREATE TABLE IF NOT EXISTS app_settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pinned_files (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS pinned_folders (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS expanded_folders (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE
        );",
    )
    .map_err(|e| format!("创建表失败: {}", e))?;

    let mut guard = DB.lock();
    *guard = Some(conn);

    println!("项目数据库已初始化: {:?}", db_path);
    Ok(())
}

// ── Settings migration (settings.json → projects table) ────────

/// 从 Tauri plugin-store 的 settings.json 中提取项目数据并导入 SQLite
#[tauri::command]
pub fn migrate_from_settings_json(
    app: AppHandle,
    json_content: Option<String>,
) -> Result<String, String> {
    let json: serde_json::Value = if let Some(content) = json_content {
        // 从前端传入的 JSON 内容解析
        serde_json::from_str(&content).map_err(|e| format!("JSON 解析失败: {}", e))?
    } else {
        // 从文件系统读取 settings.json
        let settings_path = get_settings_path(&app);
        let content = fs::read_to_string(&settings_path).map_err(|e| {
            format!(
                "读取 settings.json 失败 ({}): {}",
                settings_path.display(),
                e
            )
        })?;
        serde_json::from_str(&content).map_err(|e| format!("JSON 解析失败: {}", e))?
    };

    let now = Local::now().to_rfc3339();
    let mut imported = 0i64;
    let mut skipped = 0i64;
    let mut errors = Vec::new();

    // 获取已存在的路径集合
    let mut existing_paths: std::collections::HashSet<String> = with_db(|conn| {
        let mut stmt = conn.prepare("SELECT path FROM projects")?;
        let paths = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(paths.into_iter().collect())
    })?;

    with_db(|conn| {
        // ── 1. 从 rootPaths 导入 ──
        if let Some(root_paths) = json.get("rootPaths").and_then(|v| v.as_array()) {
            for path_val in root_paths {
                if let Some(path_str) = path_val.as_str() {
                    let normalized = path_str.replace('\\', "/");
                    if existing_paths.contains(&normalized) {
                        skipped += 1;
                        continue;
                    }

                    let name = Path::new(path_str)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| path_str.to_string());

                    match conn.execute(
                        "INSERT OR IGNORE INTO projects (name, path, tags, created_at, last_opened_at, opened_count)
                         VALUES (?1, ?2, 'root', ?3, ?3, 1)",
                        params![name, normalized, now],
                    ) {
                        Ok(rows) if rows > 0 => imported += 1,
                        Ok(_) => skipped += 1,
                        Err(e) => errors.push(format!("rootPaths '{}': {}", path_str, e)),
                    }
                    existing_paths.insert(normalized);
                }
            }
        }

        // ── 2. 从 defaultFolders 导入 ──
        if let Some(folders) = json.get("defaultFolders").and_then(|v| v.as_array()) {
            for folder in folders {
                let name = folder
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("untitled");
                let path_str = folder.get("path").and_then(|v| v.as_str()).unwrap_or("");
                if path_str.is_empty() {
                    continue;
                }
                let normalized = path_str.replace('\\', "/");
                if existing_paths.contains(&normalized) {
                    skipped += 1;
                    continue;
                }

                match conn.execute(
                    "INSERT OR IGNORE INTO projects (name, path, tags, created_at, last_opened_at, opened_count)
                     VALUES (?1, ?2, 'default-folder', ?3, ?3, 1)",
                    params![name, normalized, now],
                ) {
                    Ok(rows) if rows > 0 => imported += 1,
                    Ok(_) => skipped += 1,
                    Err(e) => errors.push(format!("defaultFolders '{}': {}", path_str, e)),
                }
                existing_paths.insert(normalized);
            }
        }

        // ── 3. 从 tabs 中提取路径（有独立 path 的标签页）──
        if let Some(tabs) = json.get("tabs").and_then(|v| v.as_array()) {
            for tab in tabs {
                let path_str = tab.get("path").and_then(|v| v.as_str()).unwrap_or("");
                if path_str.is_empty() {
                    continue;
                }
                let normalized = path_str.replace('\\', "/");

                // 跳过临时文件
                if normalized.contains("/tmp/") || normalized.contains("\\tmp\\") {
                    continue;
                }

                if existing_paths.contains(&normalized) {
                    continue;
                }

                let name: String = tab
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| {
                        Path::new(path_str)
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default()
                    });

                if name.is_empty() {
                    continue;
                }

                match conn.execute(
                    "INSERT OR IGNORE INTO projects (name, path, tags, created_at, last_opened_at, opened_count)
                     VALUES (?1, ?2, 'tab', ?3, ?3, 1)",
                    params![name, normalized, now],
                ) {
                    Ok(rows) if rows > 0 => imported += 1,
                    Ok(_) => skipped += 1,
                    Err(e) => errors.push(format!("tabs '{}': {}", path_str, e)),
                }
                existing_paths.insert(normalized);
            }
        }

        Ok(())
    })?;

    // ── 4. 从 tabs 导入标签页数据 ──
    let (tab_imported, tab_skipped, tab_errors) = migrate_tabs_from_json(&json)?;
    imported += tab_imported;
    skipped += tab_skipped;
    errors.extend(tab_errors.into_iter().map(|e| format!("tabs: {}", e)));

    // ── 5. 导入 app_settings (key-value 设置) ──
    let setting_keys = [
        "isLeftSidebarCollapsed",
        "isRightSidebarCollapsed",
        "isTerminalVisible",
        "leftSidebarWidth",
        "rightSidebarWidth",
        "terminalHeight",
        "editorWordWrap",
        "maxOpenTabs",
        "activeTabId",
        "rightSidebarIconOrder",
        "windowSize",
        "windowPosition",
    ];
    with_db(|conn| {
        for key in &setting_keys {
            if let Some(val) = json.get(*key) {
                let value_str = serde_json::to_string(val).unwrap_or_default();
                // 避免覆盖已有的设置
                let exists: bool = conn
                    .query_row(
                        "SELECT 1 FROM app_settings WHERE key = ?1",
                        params![key],
                        |_| Ok(true),
                    )
                    .unwrap_or(false);
                if !exists {
                    conn.execute(
                        "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?1, ?2)",
                        params![key, value_str],
                    )?;
                }
            }
        }
        Ok(())
    })?;

    // ── 6. 导入 pinnedFiles ──
    if let Some(files) = json.get("pinnedFiles").and_then(|v| v.as_array()) {
        with_db(|conn| {
            for file in files {
                let name = file
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("untitled");
                let path_str = file.get("path").and_then(|v| v.as_str()).unwrap_or("");
                if path_str.is_empty() {
                    continue;
                }
                let normalized = path_str.replace('\\', "/");
                conn.execute(
                    "INSERT OR IGNORE INTO pinned_files (name, path) VALUES (?1, ?2)",
                    params![name, normalized],
                )?;
                imported += 1;
            }
            Ok(())
        })?;
    }

    // ── 7. 导入 pinnedFolders ──
    if let Some(folders) = json.get("pinnedFolders").and_then(|v| v.as_array()) {
        with_db(|conn| {
            for folder in folders {
                let path_str = folder.as_str().unwrap_or("");
                if path_str.is_empty() {
                    continue;
                }
                let normalized = path_str.replace('\\', "/");
                conn.execute(
                    "INSERT OR IGNORE INTO pinned_folders (path) VALUES (?1)",
                    params![normalized],
                )?;
                imported += 1;
            }
            Ok(())
        })?;
    }

    // ── 8. 导入 expandedFolders ──
    if let Some(folders) = json.get("expandedFolders").and_then(|v| v.as_array()) {
        with_db(|conn| {
            for folder in folders {
                let path_str = folder.as_str().unwrap_or("");
                if path_str.is_empty() {
                    continue;
                }
                let normalized = path_str.replace('\\', "/");
                conn.execute(
                    "INSERT OR IGNORE INTO expanded_folders (path) VALUES (?1)",
                    params![normalized],
                )?;
                imported += 1;
            }
            Ok(())
        })?;
    }

    let mut report = format!("全部迁移完成！成功导入 {} 个项目/标签页/设置", imported);
    if skipped > 0 {
        report.push_str(&format!("，跳过 {} 个已存在", skipped));
    }
    if !errors.is_empty() {
        report.push_str(&format!("，{} 个错误", errors.len()));
        for e in &errors {
            eprintln!("迁移错误: {}", e);
        }
    }

    Ok(report)
}

/// 获取 Tauri plugin-store 的 settings.json 文件路径
fn get_settings_path(app: &AppHandle) -> PathBuf {
    let app_dir = app.path().app_data_dir().expect("无法获取应用数据目录");
    app_dir.join("settings.json")
}

// ── Project CRUD ───────────────────────────────────────────────

#[tauri::command]
pub fn get_all_projects() -> Result<Vec<Project>, String> {
    with_db(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, path, description, tags, is_pinned, last_opened_at, created_at, opened_count
             FROM projects
             ORDER BY is_pinned DESC, last_opened_at DESC, name ASC",
        )?;

        let projects = stmt
            .query_map([], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    description: row.get(3)?,
                    tags: row.get(4)?,
                    is_pinned: row.get::<_, i64>(5)? != 0,
                    last_opened_at: row.get(6)?,
                    created_at: row.get(7)?,
                    opened_count: row.get(8)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(projects)
    })
}

#[tauri::command]
pub fn add_project(project: NewProject) -> Result<Project, String> {
    let now = Local::now().to_rfc3339();
    let NewProject {
        name,
        path,
        description,
        tags,
    } = project;

    // 标准化路径分隔符
    let normalized_path = path.replace('\\', "/");

    with_db(|conn| {
        conn.execute(
            "INSERT INTO projects (name, path, description, tags, created_at, last_opened_at, opened_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1)",
            params![name, normalized_path, description, tags, now],
        )?;

        let id = conn.last_insert_rowid();
        Ok(Project {
            id,
            name,
            path: normalized_path,
            description,
            tags,
            is_pinned: false,
            last_opened_at: Some(now.clone()),
            created_at: now,
            opened_count: 1,
        })
    })
}

#[tauri::command]
pub fn update_project(
    id: i64,
    name: Option<String>,
    description: Option<String>,
    tags: Option<String>,
) -> Result<(), String> {
    with_db(|conn| {
        if let Some(name) = name {
            conn.execute(
                "UPDATE projects SET name = ?1 WHERE id = ?2",
                params![name, id],
            )?;
        }
        if let Some(description) = description {
            conn.execute(
                "UPDATE projects SET description = ?1 WHERE id = ?2",
                params![description, id],
            )?;
        }
        if let Some(tags) = tags {
            conn.execute(
                "UPDATE projects SET tags = ?1 WHERE id = ?2",
                params![tags, id],
            )?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn delete_project(id: i64) -> Result<(), String> {
    with_db(|conn| {
        conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn toggle_pin_project(id: i64) -> Result<bool, String> {
    with_db(|conn| {
        let current_pinned: i64 = conn.query_row(
            "SELECT is_pinned FROM projects WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;

        let new_pinned = if current_pinned == 0 { 1 } else { 0 };
        conn.execute(
            "UPDATE projects SET is_pinned = ?1 WHERE id = ?2",
            params![new_pinned, id],
        )?;

        Ok(new_pinned != 0)
    })
}

#[tauri::command]
pub fn record_project_opened(path: String) -> Result<(), String> {
    let now = Local::now().to_rfc3339();
    let normalized_path = path.replace('\\', "/");

    with_db(|conn| {
        conn.execute(
            "UPDATE projects SET last_opened_at = ?1, opened_count = opened_count + 1 WHERE path = ?2",
            params![now, normalized_path],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn search_projects(query: String) -> Result<Vec<Project>, String> {
    with_db(|conn| {
        let pattern = format!("%{}%", query);
        let mut stmt = conn.prepare(
            "SELECT id, name, path, description, tags, is_pinned, last_opened_at, created_at, opened_count
             FROM projects
             WHERE name LIKE ?1 OR path LIKE ?1 OR COALESCE(tags, '') LIKE ?1
             ORDER BY is_pinned DESC,
                      CASE WHEN name LIKE ?1 THEN 0 ELSE 1 END,
                      last_opened_at DESC",
        )?;

        let projects = stmt
            .query_map(params![pattern], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    description: row.get(3)?,
                    tags: row.get(4)?,
                    is_pinned: row.get::<_, i64>(5)? != 0,
                    last_opened_at: row.get(6)?,
                    created_at: row.get(7)?,
                    opened_count: row.get(8)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(projects)
    })
}

#[tauri::command]
pub fn get_project_by_path(path: String) -> Result<Option<Project>, String> {
    let normalized_path = path.replace('\\', "/");
    with_db(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, path, description, tags, is_pinned, last_opened_at, created_at, opened_count
             FROM projects WHERE path = ?1",
        )?;

        let mut rows = stmt.query_map(params![normalized_path], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                description: row.get(3)?,
                tags: row.get(4)?,
                is_pinned: row.get::<_, i64>(5)? != 0,
                last_opened_at: row.get(6)?,
                created_at: row.get(7)?,
                opened_count: row.get(8)?,
            })
        })?;

        match rows.next() {
            Some(Ok(project)) => Ok(Some(project)),
            _ => Ok(None),
        }
    })
}

#[tauri::command]
pub fn sync_root_projects(paths: Vec<String>) -> Result<(), String> {
    let now = Local::now().to_rfc3339();
    with_db(|conn| {
        // 1. 获取当前所有 tags 包含 'root' 的项目
        let mut stmt =
            conn.prepare("SELECT id, path, tags FROM projects WHERE tags LIKE '%root%'")?;
        let root_projects: Vec<(i64, String, String)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        let new_paths_set: std::collections::HashSet<String> =
            paths.iter().map(|p| p.replace('\\', "/")).collect();

        // 2. 移除不再新列表中的 'root' 标签
        for (id, path, tags) in root_projects {
            if !new_paths_set.contains(&path) {
                let new_tags = tags
                    .split(',')
                    .map(|t| t.trim())
                    .filter(|t| *t != "root" && !t.is_empty())
                    .collect::<Vec<_>>()
                    .join(",");

                if new_tags.is_empty() {
                    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
                } else {
                    conn.execute(
                        "UPDATE projects SET tags = ?1 WHERE id = ?2",
                        params![new_tags, id],
                    )?;
                }
            }
        }

        // 3. 添加新列表中的 'root' 标签
        for path in paths {
            let normalized = path.replace('\\', "/");
            let name = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());

            let existing: Option<(i64, String)> = conn
                .query_row(
                    "SELECT id, tags FROM projects WHERE path = ?1",
                    params![normalized],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        ))
                    },
                )
                .ok();

            if let Some((id, tags)) = existing {
                let mut tag_list: Vec<&str> = tags
                    .split(',')
                    .map(|t| t.trim())
                    .filter(|t| !t.is_empty())
                    .collect();
                if !tag_list.contains(&"root") {
                    tag_list.push("root");
                    let new_tags = tag_list.join(",");
                    conn.execute(
                        "UPDATE projects SET tags = ?1 WHERE id = ?2",
                        params![new_tags, id],
                    )?;
                }
            } else {
                conn.execute(
                    "INSERT INTO projects (name, path, tags, created_at, last_opened_at, opened_count)
                     VALUES (?1, ?2, 'root', ?3, ?3, 1)",
                    params![name, normalized, now],
                )?;
            }
        }

        Ok(())
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DefaultFolderInput {
    pub name: String,
    pub path: String,
}

#[tauri::command]
pub fn sync_default_projects(folders: Vec<DefaultFolderInput>) -> Result<(), String> {
    let now = Local::now().to_rfc3339();
    with_db(|conn| {
        // 1. 获取当前所有 tags 包含 'default-folder' 的项目
        let mut stmt =
            conn.prepare("SELECT id, path, tags FROM projects WHERE tags LIKE '%default-folder%'")?;
        let default_projects: Vec<(i64, String, String)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        let new_paths_set: std::collections::HashSet<String> =
            folders.iter().map(|f| f.path.replace('\\', "/")).collect();

        // 2. 移除不再新列表中的 'default-folder' 标签
        for (id, path, tags) in default_projects {
            if !new_paths_set.contains(&path) {
                let new_tags = tags
                    .split(',')
                    .map(|t| t.trim())
                    .filter(|t| *t != "default-folder" && !t.is_empty())
                    .collect::<Vec<_>>()
                    .join(",");

                if new_tags.is_empty() {
                    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
                } else {
                    conn.execute(
                        "UPDATE projects SET tags = ?1 WHERE id = ?2",
                        params![new_tags, id],
                    )?;
                }
            }
        }

        // 3. 添加/更新新列表中的 'default-folder' 标签
        for folder in folders {
            let normalized = folder.path.replace('\\', "/");
            let existing: Option<(i64, String)> = conn
                .query_row(
                    "SELECT id, tags FROM projects WHERE path = ?1",
                    params![normalized],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                        ))
                    },
                )
                .ok();

            if let Some((id, tags)) = existing {
                let mut tag_list: Vec<&str> = tags
                    .split(',')
                    .map(|t| t.trim())
                    .filter(|t| !t.is_empty())
                    .collect();
                if !tag_list.contains(&"default-folder") {
                    tag_list.push("default-folder");
                    let new_tags = tag_list.join(",");
                    conn.execute(
                        "UPDATE projects SET name = ?1, tags = ?2 WHERE id = ?3",
                        params![folder.name, new_tags, id],
                    )?;
                } else {
                    conn.execute(
                        "UPDATE projects SET name = ?1 WHERE id = ?2",
                        params![folder.name, id],
                    )?;
                }
            } else {
                conn.execute(
                    "INSERT INTO projects (name, path, tags, created_at, last_opened_at, opened_count)
                     VALUES (?1, ?2, 'default-folder', ?3, ?3, 1)",
                    params![folder.name, normalized, now],
                )?;
            }
        }

        Ok(())
    })
}

// ── Tab CRUD ───────────────────────────────────────────────────

#[tauri::command]
pub fn get_all_tabs() -> Result<Vec<Tab>, String> {
    with_db(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, file_id, name, path, language, content, view_mode,
                    is_dirty, is_read_only, is_preview_mode, is_live_preview,
                    size, sort_order, created_at, updated_at
             FROM tabs ORDER BY sort_order ASC, id ASC",
        )?;

        let tabs = stmt
            .query_map([], |row| {
                Ok(Tab {
                    id: row.get(0)?,
                    file_id: row.get(1)?,
                    name: row.get(2)?,
                    path: row.get(3)?,
                    language: row.get(4)?,
                    content: row.get(5)?,
                    view_mode: row.get(6)?,
                    is_dirty: row.get::<_, i64>(7)? != 0,
                    is_read_only: row.get::<_, i64>(8)? != 0,
                    is_preview_mode: row.get::<_, i64>(9)? != 0,
                    is_live_preview: row.get::<_, i64>(10)? != 0,
                    size: row.get(11)?,
                    sort_order: row.get(12)?,
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(tabs)
    })
}

#[tauri::command]
pub fn get_tab_by_file_id(file_id: String) -> Result<Option<Tab>, String> {
    with_db(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, file_id, name, path, language, content, view_mode,
                    is_dirty, is_read_only, is_preview_mode, is_live_preview,
                    size, sort_order, created_at, updated_at
             FROM tabs WHERE file_id = ?1",
        )?;

        let mut rows = stmt.query_map(params![file_id], |row| {
            Ok(Tab {
                id: row.get(0)?,
                file_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                language: row.get(4)?,
                content: row.get(5)?,
                view_mode: row.get(6)?,
                is_dirty: row.get::<_, i64>(7)? != 0,
                is_read_only: row.get::<_, i64>(8)? != 0,
                is_preview_mode: row.get::<_, i64>(9)? != 0,
                is_live_preview: row.get::<_, i64>(10)? != 0,
                size: row.get(11)?,
                sort_order: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        })?;

        match rows.next() {
            Some(Ok(tab)) => Ok(Some(tab)),
            _ => Ok(None),
        }
    })
}

#[tauri::command]
pub fn upsert_tab(tab: NewTab) -> Result<Tab, String> {
    let now = Local::now().to_rfc3339();
    let normalized_path = tab.path.replace('\\', "/");

    with_db(|conn| {
        // 检查是否已存在
        let existing: Option<(i64, String)> = conn
            .query_row(
                "SELECT id, updated_at FROM tabs WHERE file_id = ?1",
                params![tab.file_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        if let Some((existing_id, _old_updated)) = existing {
            // ── 更新已有标签页 ──
            conn.execute(
                "UPDATE tabs SET
                    name = ?1, path = ?2, language = ?3, content = ?4,
                    view_mode = ?5, is_dirty = ?6, is_read_only = ?7,
                    is_preview_mode = ?8, is_live_preview = ?9,
                    size = ?10, sort_order = ?11, updated_at = ?12
                 WHERE id = ?13",
                params![
                    tab.name,
                    normalized_path,
                    tab.language.unwrap_or_else(|| "plaintext".into()),
                    tab.content.unwrap_or_default(),
                    tab.view_mode.unwrap_or_else(|| "text".into()),
                    tab.is_dirty.map(|v| v as i64).unwrap_or(0),
                    tab.is_read_only.map(|v| v as i64).unwrap_or(0),
                    tab.is_preview_mode.map(|v| v as i64).unwrap_or(0),
                    tab.is_live_preview.map(|v| v as i64).unwrap_or(0),
                    tab.size.unwrap_or(0),
                    tab.sort_order.unwrap_or(0),
                    now,
                    existing_id,
                ],
            )?;

            // 返回更新后的数据
            let mut stmt = conn.prepare(
                "SELECT id, file_id, name, path, language, content, view_mode,
                        is_dirty, is_read_only, is_preview_mode, is_live_preview,
                        size, sort_order, created_at, updated_at
                 FROM tabs WHERE id = ?1",
            )?;

            stmt.query_row(params![existing_id], |row| {
                Ok(Tab {
                    id: row.get(0)?,
                    file_id: row.get(1)?,
                    name: row.get(2)?,
                    path: row.get(3)?,
                    language: row.get(4)?,
                    content: row.get(5)?,
                    view_mode: row.get(6)?,
                    is_dirty: row.get::<_, i64>(7)? != 0,
                    is_read_only: row.get::<_, i64>(8)? != 0,
                    is_preview_mode: row.get::<_, i64>(9)? != 0,
                    is_live_preview: row.get::<_, i64>(10)? != 0,
                    size: row.get(11)?,
                    sort_order: row.get(12)?,
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                })
            })
        } else {
            // ── 插入新标签页 ──
            conn.execute(
                "INSERT INTO tabs (file_id, name, path, language, content, view_mode,
                                   is_dirty, is_read_only, is_preview_mode, is_live_preview,
                                   size, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
                params![
                    tab.file_id,
                    tab.name,
                    normalized_path,
                    tab.language.unwrap_or_else(|| "plaintext".into()),
                    tab.content.unwrap_or_default(),
                    tab.view_mode.unwrap_or_else(|| "text".into()),
                    tab.is_dirty.map(|v| v as i64).unwrap_or(0),
                    tab.is_read_only.map(|v| v as i64).unwrap_or(0),
                    tab.is_preview_mode.map(|v| v as i64).unwrap_or(0),
                    tab.is_live_preview.map(|v| v as i64).unwrap_or(0),
                    tab.size.unwrap_or(0),
                    tab.sort_order.unwrap_or(0),
                    now,
                ],
            )?;

            let new_id = conn.last_insert_rowid();

            // 返回新插入的数据
            let mut stmt = conn.prepare(
                "SELECT id, file_id, name, path, language, content, view_mode,
                        is_dirty, is_read_only, is_preview_mode, is_live_preview,
                        size, sort_order, created_at, updated_at
                 FROM tabs WHERE id = ?1",
            )?;

            stmt.query_row(params![new_id], |row| {
                Ok(Tab {
                    id: row.get(0)?,
                    file_id: row.get(1)?,
                    name: row.get(2)?,
                    path: row.get(3)?,
                    language: row.get(4)?,
                    content: row.get(5)?,
                    view_mode: row.get(6)?,
                    is_dirty: row.get::<_, i64>(7)? != 0,
                    is_read_only: row.get::<_, i64>(8)? != 0,
                    is_preview_mode: row.get::<_, i64>(9)? != 0,
                    is_live_preview: row.get::<_, i64>(10)? != 0,
                    size: row.get(11)?,
                    sort_order: row.get(12)?,
                    created_at: row.get(13)?,
                    updated_at: row.get(14)?,
                })
            })
        }
    })
}

#[tauri::command]
pub fn delete_tab(file_id: String) -> Result<(), String> {
    with_db(|conn| {
        conn.execute("DELETE FROM tabs WHERE file_id = ?1", params![file_id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn update_tab_content(file_id: String, content: String) -> Result<(), String> {
    let now = Local::now().to_rfc3339();
    with_db(|conn| {
        conn.execute(
            "UPDATE tabs SET content = ?1, updated_at = ?2, is_dirty = 1 WHERE file_id = ?3",
            params![content, now, file_id],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn update_tab_order(orders: Vec<TabOrder>) -> Result<(), String> {
    with_db(|conn| {
        for order in &orders {
            conn.execute(
                "UPDATE tabs SET sort_order = ?1 WHERE file_id = ?2",
                params![order.sort_order, order.file_id],
            )?;
        }
        Ok(())
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TabOrder {
    pub file_id: String,
    pub sort_order: i64,
}

#[tauri::command]
pub fn clear_all_tabs() -> Result<(), String> {
    with_db(|conn| {
        conn.execute("DELETE FROM tabs", [])?;
        Ok(())
    })
}

#[tauri::command]
pub fn get_tab_count() -> Result<i64, String> {
    with_db(|conn| conn.query_row("SELECT COUNT(*) FROM tabs", [], |row| row.get(0)))
}

// ── Tab migration from settings.json ───────────────────────────

fn migrate_tabs_from_json(json: &serde_json::Value) -> Result<(i64, i64, Vec<String>), String> {
    let now = Local::now().to_rfc3339();
    let mut imported = 0i64;
    let mut skipped = 0i64;
    let mut errors = Vec::new();

    let existing_ids: std::collections::HashSet<String> = with_db(|conn| {
        let mut stmt = conn.prepare("SELECT file_id FROM tabs")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(ids.into_iter().collect())
    })?;

    if let Some(tabs) = json.get("tabs").and_then(|v| v.as_array()) {
        for (idx, tab) in tabs.iter().enumerate() {
            let file_id = tab
                .get("id")
                .and_then(|v: &serde_json::Value| v.as_str())
                .unwrap_or("");
            if file_id.is_empty() {
                skipped += 1;
                continue;
            }

            if existing_ids.contains(file_id) {
                skipped += 1;
                continue;
            }

            let name = tab
                .get("name")
                .and_then(|v: &serde_json::Value| v.as_str())
                .unwrap_or("untitled");
            let path_str = tab
                .get("path")
                .and_then(|v: &serde_json::Value| v.as_str())
                .unwrap_or("");
            let normalized_path = path_str.replace('\\', "/");
            let language = tab
                .get("language")
                .and_then(|v: &serde_json::Value| v.as_str())
                .unwrap_or("plaintext");
            let content = tab
                .get("content")
                .and_then(|v: &serde_json::Value| v.as_str())
                .unwrap_or("");
            let view_mode = tab
                .get("viewMode")
                .and_then(|v: &serde_json::Value| v.as_str())
                .unwrap_or("text");
            let is_dirty = tab
                .get("isDirty")
                .and_then(|v: &serde_json::Value| v.as_i64())
                .unwrap_or(0);
            let is_read_only = tab
                .get("isReadOnly")
                .and_then(|v: &serde_json::Value| v.as_i64())
                .unwrap_or(0);
            let is_preview = tab
                .get("isPreviewMode")
                .and_then(|v: &serde_json::Value| v.as_i64())
                .unwrap_or(0);
            let is_live_preview = tab
                .get("isLivePreviewMode")
                .and_then(|v: &serde_json::Value| v.as_i64())
                .unwrap_or(0);
            let size = tab
                .get("size")
                .and_then(|v: &serde_json::Value| v.as_i64())
                .unwrap_or(0);

            match with_db(|conn| {
                conn.execute(
                    "INSERT INTO tabs (file_id, name, path, language, content, view_mode,
                                       is_dirty, is_read_only, is_preview_mode, is_live_preview,
                                       size, sort_order, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
                    params![
                        file_id,
                        name,
                        normalized_path,
                        language,
                        content,
                        view_mode,
                        is_dirty,
                        is_read_only,
                        is_preview,
                        is_live_preview,
                        size,
                        idx as i64,
                        now,
                    ],
                )
            }) {
                Ok(_) => imported += 1,
                Err(e) => errors.push(format!("tab '{}' ({}): {}", name, file_id, e)),
            }
        }
    }

    Ok((imported, skipped, errors))
}

// ── Utility Tauri commands ─────────────────────────────────────

#[tauri::command]
pub fn get_project_count() -> Result<i64, String> {
    with_db(|conn| conn.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0)))
}

#[tauri::command]
pub fn get_recent_projects(limit: Option<i64>) -> Result<Vec<Project>, String> {
    let limit = limit.unwrap_or(10);
    with_db(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, path, description, tags, is_pinned, last_opened_at, created_at, opened_count
             FROM projects
             ORDER BY last_opened_at DESC
             LIMIT ?1",
        )?;

        let projects = stmt
            .query_map(params![limit], |row| {
                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    description: row.get(3)?,
                    tags: row.get(4)?,
                    is_pinned: row.get::<_, i64>(5)? != 0,
                    last_opened_at: row.get(6)?,
                    created_at: row.get(7)?,
                    opened_count: row.get(8)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        Ok(projects)
    })
}

// ── App Settings CRUD (key-value store) ───────────────────────

#[tauri::command]
pub fn get_setting(key: String) -> Result<Option<String>, String> {
    with_db(|conn| {
        conn.query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| {
            if e == rusqlite::Error::QueryReturnedNoRows {
                Ok(None)
            } else {
                Err(e)
            }
        })
    })
}

#[tauri::command]
pub fn set_setting(key: String, value: String) -> Result<(), String> {
    with_db(|conn| {
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn get_all_settings() -> Result<Vec<SettingEntry>, String> {
    with_db(|conn| {
        let mut stmt = conn.prepare("SELECT key, value FROM app_settings ORDER BY key")?;
        let entries = stmt
            .query_map([], |row| {
                Ok(SettingEntry {
                    key: row.get(0)?,
                    value: row.get(1)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(entries)
    })
}

#[tauri::command]
pub fn delete_setting(key: String) -> Result<(), String> {
    with_db(|conn| {
        conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
        Ok(())
    })
}

// ── Pinned Files CRUD ─────────────────────────────────────────

#[tauri::command]
pub fn get_pinned_files() -> Result<Vec<PinnedFileRecord>, String> {
    with_db(|conn| {
        let mut stmt = conn.prepare("SELECT id, name, path FROM pinned_files ORDER BY name")?;
        let files = stmt
            .query_map([], |row| {
                Ok(PinnedFileRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(files)
    })
}

#[tauri::command]
pub fn add_pinned_file(name: String, path: String) -> Result<PinnedFileRecord, String> {
    let normalized_path = path.replace('\\', "/");
    with_db(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO pinned_files (name, path) VALUES (?1, ?2)",
            params![name, normalized_path],
        )?;
        let id = conn.last_insert_rowid();
        Ok(PinnedFileRecord {
            id,
            name,
            path: normalized_path,
        })
    })
}

#[tauri::command]
pub fn remove_pinned_file(path: String) -> Result<(), String> {
    let normalized_path = path.replace('\\', "/");
    with_db(|conn| {
        conn.execute(
            "DELETE FROM pinned_files WHERE path = ?1",
            params![normalized_path],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn sync_pinned_files(files: Vec<PinnedFileInput>) -> Result<(), String> {
    with_db(|conn| {
        conn.execute("DELETE FROM pinned_files", [])?;
        for file in &files {
            let normalized = file.path.replace('\\', "/");
            conn.execute(
                "INSERT INTO pinned_files (name, path) VALUES (?1, ?2)",
                params![file.name, normalized],
            )?;
        }
        Ok(())
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PinnedFileInput {
    pub name: String,
    pub path: String,
}

// ── Pinned Folders CRUD ───────────────────────────────────────

#[tauri::command]
pub fn get_pinned_folders() -> Result<Vec<String>, String> {
    with_db(|conn| {
        let mut stmt = conn.prepare("SELECT path FROM pinned_folders ORDER BY path")?;
        let folders = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(folders)
    })
}

#[tauri::command]
pub fn add_pinned_folder(path: String) -> Result<(), String> {
    let normalized = path.replace('\\', "/");
    with_db(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO pinned_folders (path) VALUES (?1)",
            params![normalized],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn remove_pinned_folder(path: String) -> Result<(), String> {
    let normalized = path.replace('\\', "/");
    with_db(|conn| {
        conn.execute(
            "DELETE FROM pinned_folders WHERE path = ?1",
            params![normalized],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn sync_pinned_folders(folders: Vec<String>) -> Result<(), String> {
    with_db(|conn| {
        conn.execute("DELETE FROM pinned_folders", [])?;
        for folder in &folders {
            let normalized = folder.replace('\\', "/");
            conn.execute(
                "INSERT INTO pinned_folders (path) VALUES (?1)",
                params![normalized],
            )?;
        }
        Ok(())
    })
}

// ── Expanded Folders CRUD ─────────────────────────────────────

#[tauri::command]
pub fn get_expanded_folders() -> Result<Vec<String>, String> {
    with_db(|conn| {
        let mut stmt = conn.prepare("SELECT path FROM expanded_folders ORDER BY path")?;
        let folders = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(folders)
    })
}

#[tauri::command]
pub fn add_expanded_folder(path: String) -> Result<(), String> {
    let normalized = path.replace('\\', "/");
    with_db(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO expanded_folders (path) VALUES (?1)",
            params![normalized],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn remove_expanded_folder(path: String) -> Result<(), String> {
    let normalized = path.replace('\\', "/");
    with_db(|conn| {
        conn.execute(
            "DELETE FROM expanded_folders WHERE path = ?1",
            params![normalized],
        )?;
        Ok(())
    })
}

#[tauri::command]
pub fn sync_expanded_folders(folders: Vec<String>) -> Result<(), String> {
    with_db(|conn| {
        conn.execute("DELETE FROM expanded_folders", [])?;
        for folder in &folders {
            let normalized = folder.replace('\\', "/");
            conn.execute(
                "INSERT INTO expanded_folders (path) VALUES (?1)",
                params![normalized],
            )?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn clear_expanded_folders() -> Result<(), String> {
    with_db(|conn| {
        conn.execute("DELETE FROM expanded_folders", [])?;
        Ok(())
    })
}
