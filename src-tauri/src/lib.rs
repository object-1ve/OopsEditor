use std::fs;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

mod terminal;
use terminal::{close_terminal, create_terminal, resize_terminal, write_to_terminal};

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| format!("保存文件失败: {}", e))
}

#[tauri::command]
fn is_directory(path: String) -> bool {
    fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

#[derive(serde::Serialize)]
struct DirEntry {
    path: String,
    name: String,
    is_dir: bool,
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

        result.push(DirEntry {
            path: path.to_string_lossy().to_string(),
            name,
            is_dir,
        });
    }
    result.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir) // Directories first
        } else {
            a.name.cmp(&b.name)
        }
    });
    Ok(result)
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
        std::process::Command::new("explorer")
            .args(["/select,", &path])
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
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
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
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        });

    builder
        .invoke_handler(generate_handler())
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}

fn generate_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        read_file,
        save_file,
        list_dir,
        is_directory,
        create_file,
        create_dir,
        open_terminal,
        reveal_in_explorer,
        rename_item,
        delete_item,
        create_terminal,
        write_to_terminal,
        resize_terminal,
        close_terminal
    ]
}
