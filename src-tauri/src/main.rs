// 防止 Windows 下额外弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

use tauri::RunEvent;
use tauri_plugin_dialog::DialogExt;

/// 前端拿端口拼 sidecar 的 base URL
#[tauri::command]
fn get_backend_port(state: tauri::State<sidecar::SidecarHandle>) -> u16 {
    state.port
}

/// 前端每个请求都要带这个 token，否则 sidecar 会返回 401
#[tauri::command]
fn get_backend_token(state: tauri::State<sidecar::SidecarHandle>) -> String {
    state.token.clone()
}

/// 原生文件夹选择器，用于 COMSOL 自动探测失败时的手动兜底
#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    rx.recv().ok().flatten().map(|path| path.to_string())
}

/// 在系统文件管理器里打开一个目录（设置页「打开日志目录」用）
#[tauri::command]
fn reveal_directory(path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("目录不存在：{path}"));
    }

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(&target).spawn();

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&target).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&target).spawn();

    result.map(|_| ()).map_err(|error| error.to_string())
}

fn main() {
    // 每次启动挑一个空闲端口给 sidecar，避免和用户机器上其他服务冲突
    let port = portpicker::pick_unused_port().unwrap_or(8765);
    let token = sidecar::make_token();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(sidecar::SidecarHandle {
            port,
            token: token.clone(),
        })
        .manage(sidecar::SidecarProcess(std::sync::Mutex::new(None)))
        .setup(move |app| {
            sidecar::spawn_sidecar(app.handle(), port, &token)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            get_backend_token,
            pick_directory,
            reveal_directory
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 应用启动失败")
        .run(|app_handle, event| {
            // 关窗时顺手回收开发态子进程；打包态由 shell 插件负责
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                sidecar::kill_sidecar(app_handle);
            }
        });
}
