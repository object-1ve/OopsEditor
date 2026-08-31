use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::fs;
use std::time::UNIX_EPOCH;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use std::path::Path;
use tauri::Emitter;

/// 待打开文件队列：Windows 文件关联启动时传入的文件路径。
struct PendingFiles(parking_lot::Mutex<Vec<String>>);

/// 从命令行参数中筛选出文件路径（跳过 args[0]=可执行文件路径）。
fn collect_file_paths<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|arg| Path::new(arg).is_file())
        .collect()
}

#[tauri::command]
fn take_pending_files(state: tauri::State<PendingFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock())
}

fn is_capture_protection_enabled() -> bool {
    let config: serde_json::Value = match serde_json::from_str(include_str!("../runtime-config.json")) {
        Ok(v) => v,
        Err(_) => return true,
    };

    config
        .get("captureProtection")
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

/// 显示并激活主窗口,确保在文件关联双击/托盘点击时弹出到前台。
/// Windows 前台锁会阻止后台进程直接抢焦点(set_focus 会被忽略),
/// 置顶再取消置顶可绕过该限制,强制把窗口带到前台。
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.set_always_on_top(true);
        let _ = window.set_always_on_top(false);
    }
}

mod terminal;
use terminal::{close_terminal, create_terminal, resize_terminal, write_to_terminal};

mod git;
use git::{
    git_add, git_check_repo, git_commit, git_get_status, git_get_user, git_init, git_pull,
    git_push, git_remote_add, git_remote_get, git_resolve_repo_root,
};

mod db;
use db::{
    add_expanded_folder, add_pinned_file, add_pinned_folder, add_project, add_upgrade_item,
    clear_all_tabs, clear_expanded_folders, delete_project, delete_setting, delete_tab,
    delete_upgrade_item, export_upgrade_items_json, get_all_projects, get_all_settings,
    get_all_tabs, get_all_upgrade_items, get_expanded_folders, get_pinned_files,
    get_pinned_folders, get_project_by_path, get_project_count, get_recent_projects,
    get_setting, get_tab_by_file_id, get_tab_count, import_upgrade_items_json,
    init_project_database, migrate_from_settings_json, record_project_opened,
    remove_expanded_folder, remove_pinned_file, remove_pinned_folder, search_projects,
    set_setting, sync_default_projects, sync_expanded_folders, sync_pinned_files,
    sync_pinned_folders, sync_root_projects, toggle_pin_project, update_project,
    update_tab_content, update_tab_order, update_upgrade_item, upsert_tab,
};

mod sqlite;
use sqlite::{get_sqlite_table_data, get_sqlite_tables};

mod docconv;
use docconv::convert_doc_to_docx;

// ── 原有命令 ──

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    decode_text_bytes(&bytes).map_err(|e| format!("读取文件失败: {}", e))
}

#[tauri::command]
fn read_file_as_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(STANDARD.encode(bytes))
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| format!("保存文件失败: {}", e))
}

#[tauri::command]
fn save_file_from_base64(path: String, content: String) -> Result<(), String> {
    let normalized: String = content.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = STANDARD
        .decode(normalized.as_bytes())
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    fs::write(&path, bytes).map_err(|e| format!("保存文件失败: {}", e))
}



#[tauri::command]
fn copy_file(source_path: String, target_path: String) -> Result<(), String> {
    fs::copy(&source_path, &target_path).map_err(|e| format!("复制文件失败: {}", e))?;
    Ok(())
}

/// 递归复制文件或目录（用于“复制/粘贴”文件或文件夹）
fn copy_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        fs::copy(src, dst)?;
    }
    Ok(())
}

#[tauri::command]
fn copy_item(source_path: String, target_path: String) -> Result<(), String> {
    let src = std::path::Path::new(&source_path);
    let dst = std::path::Path::new(&target_path);
    if !src.exists() {
        return Err(format!("源路径不存在: {}", source_path));
    }
    if dst.exists() {
        return Err(format!("目标路径已存在: {}", target_path));
    }
    copy_recursive(src, dst).map_err(|e| format!("复制失败: {}", e))
}

#[tauri::command]
fn move_item(source_path: String, target_path: String) -> Result<(), String> {
    let src = std::path::Path::new(&source_path);
    let dst = std::path::Path::new(&target_path);
    if !src.exists() {
        return Err(format!("源路径不存在: {}", source_path));
    }
    if dst.exists() {
        return Err(format!("目标路径已存在: {}", target_path));
    }
    if fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    // rename 失败（如跨磁盘移动）时回退为“复制 + 删除源”
    if let Err(copy_err) = copy_recursive(src, dst) {
        let _ = if dst.is_dir() {
            fs::remove_dir_all(dst)
        } else {
            fs::remove_file(dst)
        };
        return Err(format!("移动失败: {}", copy_err));
    }
    let remove_result = if src.is_dir() {
        fs::remove_dir_all(src)
    } else {
        fs::remove_file(src)
    };
    remove_result.map_err(|e| format!("移动失败: {}", e))
}

#[tauri::command]
fn is_directory(path: String) -> bool {
    fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[derive(serde::Serialize)]
struct DirEntry {
    path: String,
    name: String,
    is_dir: bool,
    size: u64,
    modified_at: u64,
}

#[derive(serde::Serialize)]
struct FileInfo {
    size: u64,
    modified_at: u64,
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|e| format!("读取目录失败: {}", e))?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "".to_string());
        let is_dir = path.is_dir();

        let metadata = fs::metadata(&path).map_err(|e| format!("获取元数据失败: {}", e))?;
        let size = if is_dir { 0 } else { metadata.len() };
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);

        // 统一路径分隔符为正斜杠，避免父目录用 '/' 而子项拼接用 '\' 产生混合格式
        let normalized_path = path.to_string_lossy().replace('\\', "/");

        result.push(DirEntry {
            path: normalized_path,
            name,
            is_dir,
            size,
            modified_at,
        });
    }
    result.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir) // Directories first
        } else if a.modified_at != b.modified_at {
            b.modified_at.cmp(&a.modified_at)
        } else {
            a.name.cmp(&b.name)
        }
    });
    Ok(result)
}

#[tauri::command]
fn get_file_info(path: String) -> Result<FileInfo, String> {
    let metadata = fs::metadata(&path).map_err(|e| format!("获取文件信息失败: {}", e))?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);

    Ok(FileInfo {
        size: metadata.len(),
        modified_at,
    })
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    if std::path::Path::new(&path).exists() {
        return Err("文件已存在".to_string());
    }
    fs::write(&path, "").map_err(|e| format!("创建文件失败: {}", e))
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    if std::path::Path::new(&path).exists() {
        return Err("目录已存在".to_string());
    }
    fs::create_dir_all(&path).map_err(|e| format!("创建目录失败: {}", e))
}

#[tauri::command]
fn open_terminal(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("powershell.exe")
            .args(["-NoExit", "-Command", &format!("cd '{}'", path)])
            .spawn()
            .map_err(|e| format!("无法打开终端: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Terminal", &path])
            .spawn()
            .map_err(|e| format!("无法打开终端: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators
        let terminals = [
            "gnome-terminal",
            "konsole",
            "xfce4-terminal",
            "x-terminal-emulator",
        ];
        let mut success = false;
        for term in terminals {
            if std::process::Command::new(term)
                .args(["--working-directory", &path])
                .spawn()
                .is_ok()
            {
                success = true;
                break;
            }
        }
        if !success {
            return Err("未找到支持的终端模拟器".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // 前端路径统一为正斜杠（见 list_dir），explorer 需要反斜杠才能定位文件，
        // 否则 /select 找不到目标会回退打开"桌面"。
        let win_path = path.replace('/', "\\");
        let p = std::path::Path::new(&win_path);
        if !p.exists() {
            return Err(format!("路径不存在: {}", path));
        }
        // explorer /select,"<path>"："/select," 必须与路径紧贴为同一命令行 token，
        // 且含空格的路径需用引号包裹。用 raw_arg 手工构造，避免 Rust Command
        // 自动把整个 "/select,<path>" 包进引号导致 explorer 无法识别 /select 开关。
        let arg = format!("/select,\"{}\"", win_path);
        std::process::Command::new("explorer")
            .raw_arg(arg)
            .spawn()
            .map_err(|e| format!("无法打开资源管理器: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("无法打开访达: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        // For linux, it's more complex, but usually dbus or opening the parent dir works
        let parent = std::path::Path::new(&path)
            .parent()
            .unwrap_or(std::path::Path::new("/"));
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("无法打开文件管理器: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn rename_item(path: String, new_path: String) -> Result<(), String> {
    fs::rename(&path, &new_path).map_err(|e| format!("重命名失败: {}", e))
}

#[tauri::command]
fn delete_item(path: String) -> Result<(), String> {
    let metadata = fs::metadata(&path).map_err(|e| format!("获取文件信息失败: {}", e))?;
    if metadata.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| format!("删除目录失败: {}", e))
    } else {
        fs::remove_file(&path).map_err(|e| format!("删除文件失败: {}", e))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    {
        // 禁用 WebView2 的追踪保护，解决 "Tracking Prevention blocked access to storage" 问题
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-features=TrackingPrevention",
        );
    }

    let builder = tauri::Builder::default()
        .manage(PendingFiles(parking_lot::Mutex::new(Vec::new())))
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let app = app.clone();
            // WM_COPYDATA 是跨进程 sent message,在其消息上下文内调用激活类 API
            // 会被 Windows 限制(SetForegroundWindow 被忽略)。延迟移出该上下文执行。
            std::thread::spawn(move || {
                let paths = collect_file_paths(args);
                if !paths.is_empty() {
                    let state = app.state::<PendingFiles>();
                    state.0.lock().extend(paths.clone());
                    let _ = app.emit("open-files", paths);
                }
                show_main_window(&app);
            });
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 初始化项目管理数据库
            if let Err(err) = db::init_project_database(app.handle().clone()) {
                eprintln!("初始化数据库失败: {}", err);
            }
            // 文件关联启动：收集首次启动时传入的文件路径，前端挂载时取走
            let initial_paths = collect_file_paths(std::env::args());
            if !initial_paths.is_empty() {
                let state = app.state::<PendingFiles>();
                state.0.lock().extend(initial_paths);
            }

            // 防截屏/防录屏: 通过 runtime-config.json 的 captureProtection 开关控制
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                use raw_window_handle::HasWindowHandle;
                use windows::Win32::Foundation::HWND;
                use windows::Win32::UI::WindowsAndMessaging::{
                    SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
                };

                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(handle) = window.window_handle() {
                        if let raw_window_handle::RawWindowHandle::Win32(win_handle) = handle.as_raw() {
                            let hwnd = HWND(win_handle.hwnd.get() as _);
                            unsafe {
                                let affinity = if is_capture_protection_enabled() {
                                    WDA_EXCLUDEFROMCAPTURE
                                } else {
                                    WDA_NONE
                                };
                                let _ = SetWindowDisplayAffinity(hwnd, affinity);
                            }
                        }
                    }
                }
            }

            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "显示", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        show_main_window(app);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        });

    builder
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(generate_handler())
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}

fn decode_text_bytes(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(bytes[3..].to_vec())
            .map_err(|e| format!("UTF-8 解码失败: {}", e));
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_utf16_bytes(&bytes[2..], true);
    }

    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_utf16_bytes(&bytes[2..], false);
    }

    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => Ok(text),
        Err(_) => Ok(String::from_utf8_lossy(bytes).into_owned()),
    }
}

fn decode_utf16_bytes(bytes: &[u8], little_endian: bool) -> Result<String, String> {
    if !bytes.len().is_multiple_of(2) {
        return Err("UTF-16 字节长度无效".to_string());
    }

    let code_units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| {
            if little_endian {
                u16::from_le_bytes([chunk[0], chunk[1]])
            } else {
                u16::from_be_bytes([chunk[0], chunk[1]])
            }
        })
        .collect();

    String::from_utf16(&code_units).map_err(|e| format!("UTF-16 解码失败: {}", e))
}

fn generate_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        read_file,
        read_file_as_base64,
        save_file,
        save_file_from_base64,
        take_pending_files,

        copy_file,
        copy_item,
        move_item,
        list_dir,
        get_file_info,
        is_directory,
        path_exists,
        create_file,
        create_dir,
        open_terminal,
        reveal_in_explorer,
        rename_item,
        delete_item,
        create_terminal,
        write_to_terminal,
        resize_terminal,
        close_terminal,
        // 项目管理数据库命令
        init_project_database,
        get_all_projects,
        add_project,
        update_project,
        delete_project,
        toggle_pin_project,
        record_project_opened,
        search_projects,
        get_project_by_path,
        sync_root_projects,
        sync_default_projects,
        get_project_count,
        get_recent_projects,
        migrate_from_settings_json,
        // 标签页数据库命令
        get_all_tabs,
        get_tab_by_file_id,
        upsert_tab,
        delete_tab,
        update_tab_content,
        update_tab_order,
        clear_all_tabs,
        get_tab_count,
        // 应用设置 (key-value)
        get_setting,
        set_setting,
        get_all_settings,
        delete_setting,
        // 已固定文件
        get_pinned_files,
        add_pinned_file,
        remove_pinned_file,
        sync_pinned_files,
        // 已固定文件夹
        get_pinned_folders,
        add_pinned_folder,
        remove_pinned_folder,
        sync_pinned_folders,
        // 展开的文件夹
        get_expanded_folders,
        add_expanded_folder,
        remove_expanded_folder,
        sync_expanded_folders,
        clear_expanded_folders,
        // 升级日志
        get_all_upgrade_items,
        add_upgrade_item,
        update_upgrade_item,
        delete_upgrade_item,
        export_upgrade_items_json,
    import_upgrade_items_json,
        // SQLite 查看器命令
        get_sqlite_tables,
        get_sqlite_table_data,
        // .doc -> .docx 转换命令
        convert_doc_to_docx,
        // Git 命令
        git_check_repo,
        git_resolve_repo_root,
        git_init,
        git_get_status,
        git_add,
        git_commit,
        git_push,
        git_pull,
        git_remote_add,
        git_remote_get,
        git_get_user,
    ]
}
