//! Notebook 内核：为每个 .ipynb 标签维护一个常驻 Python 进程。
//!
//! 不用 ipykernel / jupyter_client：协议是一行一个 JSON（见
//! `python/notebook_kernel.py`），只依赖本机 Python 标准库。单元格串行执行，
//! 变量跨单元格保留；中断（stop）直接杀掉进程，下一次运行会重新启动内核。

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

const KERNEL_SCRIPT: &str = include_str!("../python/notebook_kernel.py");
const READY_PREFIX: &str = "__OOPS_READY__";
const RESULT_PREFIX: &str = "__OOPS_RESULT__";
const READY_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

#[derive(Serialize)]
pub struct KernelInfo {
    executable: String,
    version: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct KernelFailure {
    ename: String,
    evalue: String,
    traceback: String,
}

#[derive(Serialize)]
pub struct CellRunResult {
    stdout: String,
    stderr: String,
    result: Option<String>,
    error: Option<KernelFailure>,
}

#[derive(Deserialize)]
struct KernelResponse {
    #[serde(default)]
    stdout: String,
    #[serde(default)]
    stderr: String,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    error: Option<KernelFailure>,
}

struct KernelEntry {
    executable: String,
    version: String,
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    /// 由读线程写入：每行 stdout；进程结束后写入 None
    lines: Mutex<Receiver<Option<String>>>,
    /// 串行化单元格执行；stop 不取这把锁，才能中断正在跑的单元格
    exec: Mutex<()>,
}

static KERNELS: LazyLock<Mutex<HashMap<String, Arc<KernelEntry>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 启动（或复用）某个 Notebook 的内核。
#[tauri::command]
pub fn notebook_kernel_start(key: String, cwd: Option<String>) -> Result<KernelInfo, String> {
    if let Some(entry) = KERNELS.lock().get(&key) {
        return Ok(KernelInfo {
            executable: entry.executable.clone(),
            version: entry.version.clone(),
        });
    }

    let (executable, base_args) = resolve_interpreter()?;
    let mut command = Command::new(&executable);
    command
        .args(&base_args)
        .args(["-u", "-c", KERNEL_SCRIPT])
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd.as_deref().filter(|dir| !dir.is_empty()) {
        command.current_dir(dir);
    }
    hide_console(&mut command);

    let mut child = command
        .spawn()
        .map_err(|err| format!("启动 Python 失败（{executable}）：{err}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法连接 Python 内核的 stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法连接 Python 内核的 stdout".to_string())?;

    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    if sender.send(Some(text)).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = sender.send(None);
    });

    let (ready_executable, version) = match wait_ready(&receiver, READY_TIMEOUT) {
        Ok(info) => info,
        Err(err) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
    };

    let info = KernelInfo {
        executable: if ready_executable.is_empty() {
            executable.clone()
        } else {
            ready_executable.clone()
        },
        version: version.clone(),
    };

    KERNELS.lock().insert(
        key,
        Arc::new(KernelEntry {
            executable: info.executable.clone(),
            version: info.version.clone(),
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            lines: Mutex::new(receiver),
            exec: Mutex::new(()),
        }),
    );

    Ok(info)
}

/// 执行一个单元格；超时或进程退出会终止内核并返回可展示的原因。
#[tauri::command]
pub fn notebook_kernel_run(
    key: String,
    code: String,
    timeout_ms: Option<u64>,
) -> Result<CellRunResult, String> {
    let entry = KERNELS
        .lock()
        .get(&key)
        .cloned()
        .ok_or_else(|| "Python 内核尚未启动".to_string())?;

    let _execution = entry.exec.lock();
    let request = serde_json::json!({ "id": 1, "code": code });
    {
        let mut stdin = entry.stdin.lock();
        writeln!(stdin, "{request}").map_err(|err| format!("写入 Python 内核失败：{err}"))?;
        stdin
            .flush()
            .map_err(|err| format!("写入 Python 内核失败：{err}"))?;
    }

    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1_000, MAX_TIMEOUT_MS),
    );

    let mut payload: Option<String> = None;
    let mut timed_out = false;
    let mut closed = false;
    {
        let lines = entry.lines.lock();
        loop {
            match lines.recv_timeout(timeout) {
                Ok(Some(line)) => {
                    if let Some(rest) = line.strip_prefix(RESULT_PREFIX) {
                        payload = Some(rest.to_string());
                        break;
                    }
                }
                Ok(None) | Err(RecvTimeoutError::Disconnected) => {
                    closed = true;
                    break;
                }
                Err(RecvTimeoutError::Timeout) => {
                    timed_out = true;
                    break;
                }
            }
        }
    }

    if timed_out {
        kill_kernel(&key);
        let seconds = timeout.as_secs();
        return Ok(CellRunResult {
            stdout: String::new(),
            stderr: String::new(),
            result: None,
            error: Some(KernelFailure {
                ename: "TimeoutError".to_string(),
                evalue: format!("单元格执行超过 {seconds} 秒，内核已终止"),
                traceback: format!(
                    "TimeoutError: 单元格执行超时（{seconds} 秒）。Python 内核已被终止，下一次运行会重新启动（变量会丢失）。"
                ),
            }),
        });
    }

    if closed {
        kill_kernel(&key);
        return Err("Python 内核已退出（进程结束）".to_string());
    }

    let payload = payload.ok_or_else(|| "Python 内核返回了空结果".to_string())?;
    let response: KernelResponse = serde_json::from_str(&payload)
        .map_err(|err| format!("解析 Python 内核结果失败：{err}"))?;

    Ok(CellRunResult {
        stdout: response.stdout,
        stderr: response.stderr,
        result: response.result,
        error: response.error,
    })
}

/// 终止内核（中断正在执行的单元格）。不存在时视为成功。
#[tauri::command]
pub fn notebook_kernel_stop(key: String) -> Result<(), String> {
    kill_kernel(&key);
    Ok(())
}

/// 内核是否已启动。
#[tauri::command]
pub fn notebook_kernel_status(key: String) -> Result<bool, String> {
    Ok(KERNELS.lock().contains_key(&key))
}

fn kill_kernel(key: &str) {
    if let Some(entry) = KERNELS.lock().remove(key) {
        let mut child = entry.child.lock();
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn wait_ready(receiver: &Receiver<Option<String>>, timeout: Duration) -> Result<(String, String), String> {
    let started = std::time::Instant::now();
    loop {
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err("Python 内核启动超时（未收到就绪握手）".to_string());
        }
        match receiver.recv_timeout(remaining) {
            Ok(Some(line)) => {
                let Some(payload) = line.strip_prefix(READY_PREFIX) else {
                    continue;
                };
                let value: serde_json::Value = serde_json::from_str(payload)
                    .map_err(|err| format!("内核握手解析失败：{err}"))?;
                let version = value
                    .get("version")
                    .and_then(|item| item.as_str())
                    .unwrap_or("")
                    .to_string();
                let executable = value
                    .get("executable")
                    .and_then(|item| item.as_str())
                    .unwrap_or("")
                    .to_string();
                return Ok((executable, version));
            }
            Ok(None) => return Err("Python 内核启动后立即退出".to_string()),
            Err(RecvTimeoutError::Timeout) => {
                return Err("Python 内核启动超时（未收到就绪握手）".to_string())
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err("Python 内核输出通道已断开".to_string())
            }
        }
    }
}

/// 按优先级找一个可用的 Python 解释器。
fn resolve_interpreter() -> Result<(String, Vec<String>), String> {
    let mut candidates: Vec<(String, Vec<String>)> = vec![
        ("python".to_string(), Vec::new()),
        ("python3".to_string(), Vec::new()),
    ];
    #[cfg(target_os = "windows")]
    {
        // 只有 py launcher 而没有 python 命令的机器
        candidates.push(("py".to_string(), vec!["-3".to_string()]));
    }

    for (executable, base_args) in candidates {
        if probe_python(&executable, &base_args) {
            return Ok((executable, base_args));
        }
    }

    Err("未找到可用的 Python 解释器：请把 python（或 py -3）加入 PATH".to_string())
}

fn probe_python(executable: &str, base_args: &[String]) -> bool {
    let mut probe = Command::new(executable);
    probe
        .args(base_args)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut probe);
    probe.status().map(|status| status.success()).unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn hide_console(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_roundtrip_keeps_state_and_reports_errors() {
        let key = "test-roundtrip".to_string();
        let info = notebook_kernel_start(key.clone(), None).expect("内核应能启动");
        assert!(!info.version.is_empty(), "握手应带 Python 版本");

        let first = notebook_kernel_run(key.clone(), "x = 20\nprint('hi')".into(), None)
            .expect("第一个单元格应执行成功");
        assert_eq!(first.stdout, "hi\n");
        assert!(first.result.is_none(), "赋值语句不该有表达式回显");
        assert!(first.error.is_none());

        let second = notebook_kernel_run(key.clone(), "x + 1".into(), None)
            .expect("第二个单元格应执行成功");
        assert_eq!(second.result.as_deref(), Some("21"), "变量应跨单元格保留");

        let third = notebook_kernel_run(key.clone(), "1 / 0".into(), None)
            .expect("异常应作为结果返回而不是命令失败");
        let failure = third.error.expect("除零应返回错误输出");
        assert_eq!(failure.ename, "ZeroDivisionError");

        notebook_kernel_stop(key.clone()).expect("停止内核应成功");
        assert!(!notebook_kernel_status(key).expect("查询状态应成功"));
    }

    #[test]
    fn kernel_timeout_kills_process() {
        let key = "test-timeout".to_string();
        notebook_kernel_start(key.clone(), None).expect("内核应能启动");

        let result = notebook_kernel_run(key.clone(), "import time\ntime.sleep(30)".into(), Some(1_000))
            .expect("超时应返回结果");
        let failure = result.error.expect("超时应返回错误输出");
        assert_eq!(failure.ename, "TimeoutError");
        assert!(
            !notebook_kernel_status(key).expect("查询状态应成功"),
            "超时后内核应被移除"
        );
    }

    #[test]
    fn stopping_missing_kernel_is_ok() {
        notebook_kernel_stop("test-missing-kernel".to_string()).expect("停止不存在的内核应成功");
    }
}
