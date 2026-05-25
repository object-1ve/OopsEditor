use portable_pty::{native_pty_system, CommandBuilder, PtySize, PtyPair};
use std::io::{Read, Write};
use std::sync::Arc;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use once_cell::sync::Lazy;

pub struct TerminalState {
    pub pty_pair: Arc<Mutex<PtyPair>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

static TERMINAL_STATE: Lazy<Mutex<Option<TerminalState>>> = Lazy::new(|| Mutex::new(None));

#[tauri::command]
pub fn create_terminal(app: AppHandle, path: String) -> Result<(), String> {
    // Drop existing state if any to close previous PTY
    {
        let mut state = TERMINAL_STATE.lock();
        *state = None;
    }

    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e: anyhow::Error| e.to_string())?;

    #[cfg(target_os = "windows")]
    let mut cmd = CommandBuilder::new("powershell.exe");
    #[cfg(not(target_os = "windows"))]
    let mut cmd = CommandBuilder::new("bash");

    // Set working directory if provided
    if !path.is_empty() {
        cmd.cwd(path);
    }

    let mut _child = pty_pair.slave.spawn_command(cmd).map_err(|e: anyhow::Error| e.to_string())?;

    let reader = pty_pair.master.try_clone_reader().map_err(|e: anyhow::Error| e.to_string())?;
    let writer = pty_pair.master.take_writer().map_err(|e: anyhow::Error| e.to_string())?;

    let pty_pair_arc = Arc::new(Mutex::new(pty_pair));
    let writer_arc = Arc::new(Mutex::new(writer));

    *TERMINAL_STATE.lock() = Some(TerminalState {
        pty_pair: pty_pair_arc.clone(),
        writer: writer_arc.clone(),
    });

    // Spawn thread to read from PTY
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = app.emit("terminal-output", data);
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn write_to_terminal(data: String) -> Result<(), String> {
    if let Some(state) = TERMINAL_STATE.lock().as_ref() {
        let mut writer = state.writer.lock();
        writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Terminal not initialized".to_string())
    }
}

#[tauri::command]
pub fn resize_terminal(rows: u16, cols: u16) -> Result<(), String> {
    if let Some(state) = TERMINAL_STATE.lock().as_ref() {
        state.pty_pair.lock().master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Terminal not initialized".to_string())
    }
}
