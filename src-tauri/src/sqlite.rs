use rusqlite::{Connection, OpenFlags, Result as SqlResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct SqliteTable {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SqliteTableData {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
}

#[tauri::command]
pub fn get_sqlite_tables(path: String) -> Result<Vec<SqliteTable>, String> {
    println!("SQLite: 获取表列表, 路径={}", path);

    // 使用只读模式打开，避免锁定问题，也不要创建新文件
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("无法打开数据库 (只读模式): {}", e))?;

    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(|e| format!("准备查询失败: {}", e))?;

    let tables = stmt
        .query_map([], |row| Ok(SqliteTable { name: row.get(0)? }))
        .map_err(|e| format!("查询表列表失败: {}", e))?
        .collect::<SqlResult<Vec<_>>>()
        .map_err(|e| format!("读取表列表失败: {}", e))?;

    println!("SQLite: 找到 {} 个表", tables.len());
    Ok(tables)
}

#[tauri::command]
pub fn get_sqlite_table_data(
    path: String,
    table: String,
    limit: i64,
    offset: i64,
) -> Result<SqliteTableData, String> {
    println!(
        "SQLite: 获取表数据, 路径={}, 表={}, limit={}, offset={}",
        path, table, limit, offset
    );

    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("无法打开数据库 (只读模式): {}", e))?;

    // 验证表名，防止注入
    let mut check_stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?1")
        .map_err(|e| format!("验证表名失败: {}", e))?;
    let table_exists = check_stmt
        .exists([&table])
        .map_err(|e| format!("检查表是否存在失败: {}", e))?;

    if !table_exists {
        return Err(format!("表 '{}' 不存在", table));
    }

    let query = format!("SELECT * FROM [{}] LIMIT ?1 OFFSET ?2", table);
    let mut stmt = conn
        .prepare(&query)
        .map_err(|e| format!("准备查询失败: {}", e))?;

    let columns: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(|s| s.to_string())
        .collect();

    let column_count = columns.len();

    let rows = stmt
        .query_map([limit, offset], |row| {
            let mut values = Vec::with_capacity(column_count);
            for i in 0..column_count {
                let val: rusqlite::types::Value = row.get(i)?;
                let json_val = match val {
                    rusqlite::types::Value::Null => serde_json::Value::Null,
                    rusqlite::types::Value::Integer(i) => serde_json::Value::Number(i.into()),
                    rusqlite::types::Value::Real(f) => {
                        if let Some(n) = serde_json::Number::from_f64(f) {
                            serde_json::Value::Number(n)
                        } else {
                            serde_json::Value::Null
                        }
                    }
                    rusqlite::types::Value::Text(s) => serde_json::Value::String(s),
                    rusqlite::types::Value::Blob(b) => {
                        serde_json::Value::String(format!("<Blob: {} bytes>", b.len()))
                    }
                };
                values.push(json_val);
            }
            Ok(values)
        })
        .map_err(|e| format!("查询表数据失败: {}", e))?
        .collect::<SqlResult<Vec<_>>>()
        .map_err(|e| format!("读取表数据失败: {}", e))?;

    println!("SQLite: 读取到 {} 行数据", rows.len());
    Ok(SqliteTableData { columns, rows })
}
