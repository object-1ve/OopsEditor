use base64::{engine::general_purpose::STANDARD, Engine};
use std::hash::{Hash, Hasher};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use std::{fs, thread};

const CONVERT_TIMEOUT_SECS: u64 = 60;
const CACHE_TTL_SECS: u64 = 3600;

/// 通过 PowerShell COM 调用本机 Word，将 .doc 转为 .docx。
/// 返回转换后临时 .docx 文件的路径。
#[tauri::command]
pub fn convert_doc_to_docx(path: String) -> Result<String, String> {
    let src = std::path::Path::new(&path);
    if !src.exists() {
        return Err("文件不存在".to_string());
    }

    let tmp_dir = std::env::temp_dir().join("oops-editor-docconv");
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    cleanup_stale_cache(&tmp_dir);

    let out_name = format!("{}.docx", stable_hash(&path));
    let out_path = tmp_dir.join(&out_name);

    if out_path.exists() {
        return Ok(out_path.to_string_lossy().to_string());
    }

    let ps_script = format!(
        concat!(
            "$ErrorActionPreference='Stop';",
            "$w=New-Object -ComObject Word.Application;",
            "$w.Visible=$false;",
            "$w.DisplayAlerts=0;",
            "try {{ $d=$w.Documents.Open('{}',$false,$true,$false); $d.SaveAs2('{}',16); $d.Close() }} ",
            "finally {{ $w.Quit() }}"
        ),
        escape_ps_single(&path),
        escape_ps_single(&out_path.to_string_lossy()),
    );

    let encoded = encode_ps_command(&ps_script);

    let mut child = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 PowerShell: {}", e))?;

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(child.wait());
    });

    match rx.recv_timeout(Duration::from_secs(CONVERT_TIMEOUT_SECS)) {
        Ok(Ok(status)) if status.success() => {
            if out_path.exists() {
                Ok(out_path.to_string_lossy().to_string())
            } else {
                Err("Word 转换完成但未生成目标文件，请确认文档未损坏。".to_string())
            }
        }
        Ok(Ok(_)) => Err(
            "Word 转换失败，请确认已安装 Microsoft Word 且文档未损坏。".to_string(),
        ),
        Ok(Err(e)) => Err(format!("PowerShell 执行错误: {}", e)),
        Err(_) => Err(format!(
            "Word 转换超时（{} 秒），请确认 Word 未弹出对话框阻塞操作。",
            CONVERT_TIMEOUT_SECS
        )),
    }
}

fn cleanup_stale_cache(dir: &std::path::Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if let Ok(modified) = meta.modified() {
                    if let Ok(elapsed) = modified.elapsed() {
                        if elapsed > Duration::from_secs(CACHE_TTL_SECS) {
                            let _ = fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
    }
}

fn stable_hash(path: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn escape_ps_single(s: &str) -> String {
    s.replace('\'', "''")
}

fn encode_ps_command(script: &str) -> String {
    let ps_bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    STANDARD.encode(&ps_bytes)
}
