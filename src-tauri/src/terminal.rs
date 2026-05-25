use once_cell::sync::Lazy;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub struct TerminalState {
    pub pty_pair: Arc<Mutex<PtyPair>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
}

static TERMINAL_STATE: Lazy<Mutex<HashMap<String, TerminalState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
pub(crate) fn create_terminal(app: AppHandle, id: String, path: String) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    let mut cmd = CommandBuilder::new("powershell.exe");
    #[cfg(not(target_os = "windows"))]
    let mut cmd = CommandBuilder::new("bash");

    // Set working directory if provided
    if !path.is_empty() {
        cmd.cwd(path);
    }

    let mut _child = pty_pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    let reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|e| e.to_string())?;

    let pty_pair_arc = Arc::new(Mutex::new(pty_pair));
    let writer_arc = Arc::new(Mutex::new(writer));

    let terminal_id = id.clone();
    TERMINAL_STATE.lock().insert(
        id.clone(),
        TerminalState {
            pty_pair: pty_pair_arc.clone(),
            writer: writer_arc.clone(),
        },
    );

    // Spawn thread to read from PTY
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 1024];
        let event_name = format!("terminal-output-{}", terminal_id);
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = app.emit(&event_name, data);
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub(crate) fn write_to_terminal(id: String, data: String) -> Result<(), String> {
    let state_map = TERMINAL_STATE.lock();
    if let Some(state) = state_map.get(&id) {
        let mut writer = state.writer.lock();
        writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Terminal {} not initialized", id))
    }
}

#[tauri::command]
pub(crate) fn resize_terminal(id: String, rows: u16, cols: u16) -> Result<(), String> {
    let state_map = TERMINAL_STATE.lock();
    if let Some(state) = state_map.get(&id) {
        state
            .pty_pair
            .lock()
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err(format!("Terminal {} not initialized", id))
    }
}

#[tauri::command]
pub(crate) fn close_terminal(id: String) -> Result<(), String> {
    TERMINAL_STATE.lock().remove(&id);
    Ok(())
}
