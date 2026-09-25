//! 管理 Python sidecar 的生命周期。
//!
//! 两种形态，逻辑上等价：
//!
//! * **开发态**（`cargo tauri dev`）：直接跑 `python python-sidecar/sidecar_server.py`。
//!   脚手架原来要求手工改代码才能联调，这里做成自动回退，开发时不必先打 exe。
//! * **打包态**：跑 Tauri `externalBin` 里的 `comsolpilot-sidecar` 可执行文件，
//!   由 shell 插件负责 `-<target-triple>` 后缀与路径解析。
//!
//! 无论哪种形态，子进程的 stdout/stderr 都转发成 `sidecar-log` 事件，日志页监听
//! 同名事件即可；应用退出时由 `kill_sidecar` 回收子进程。

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// 存进 Tauri State，供 `get_backend_port` / `get_backend_token` 读取
pub struct SidecarHandle {
    pub port: u16,
    pub token: String,
}

/// 开发态子进程句柄，用于退出时回收（打包态由 shell 插件自己管）
pub struct SidecarProcess(pub Mutex<Option<Child>>);

/// 本地接口令牌。
///
/// 只绑回环地址还不够：浏览器里任意网页都能向 127.0.0.1 发请求，只是读不到响应。
/// 带一个每次启动都不同的 token，「猜不到就调不动接口」才成立。用 `RandomState`
/// （std 内部由操作系统随机源播种）取 128 位，不引入新依赖。
pub fn make_token() -> String {
    let mut token = String::with_capacity(32);
    for _ in 0..2 {
        let state = RandomState::new();
        let mut hasher = state.build_hasher();
        hasher.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        token.push_str(&format!("{:016x}", hasher.finish()));
    }
    token
}

/// 开发态下定位 python-sidecar 目录。
fn dev_sidecar_dir() -> Option<PathBuf> {
    // CARGO_MANIFEST_DIR 在编译期就指向 src-tauri/，开发时最可靠
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest.parent()?.join("python-sidecar");
    candidate.is_dir().then_some(candidate)
}

/// 挑一个能用的 Python 解释器（开发态回退用）。
fn dev_python() -> String {
    if let Ok(explicit) = std::env::var("COMSOLPILOT_PYTHON") {
        if !explicit.is_empty() {
            return explicit;
        }
    }
    for candidate in ["python", "py", "python3"] {
        let usable = Command::new(candidate)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if usable {
            return candidate.to_string();
        }
    }
    "python".to_string()
}

/// 把子进程输出逐行转发给前端。
///
/// 用独立线程而不是异步任务：这里是阻塞式 IO，放在 tokio 工作线程上会占住它。
fn forward<R>(reader: R, app: tauri::AppHandle)
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            let _ = app.emit("sidecar-log", line);
        }
    });
}

pub fn spawn_sidecar(app: &tauri::AppHandle, port: u16, token: &str) -> tauri::Result<()> {
    if cfg!(debug_assertions) {
        spawn_dev(app, port, token);
    } else {
        spawn_bundled(app, port, token)?;
    }
    Ok(())
}

/// 开发态：直接跑 Python 脚本，免去「先打 exe 才能联调」这一步。
fn spawn_dev(app: &tauri::AppHandle, port: u16, token: &str) {
    let Some(directory) = dev_sidecar_dir() else {
        let message = "[sidecar] 找不到 python-sidecar 目录，开发模式无法启动后端";
        eprintln!("{message}");
        let _ = app.emit("sidecar-log", message);
        return;
    };

    let script = directory.join("sidecar_server.py");
    let python = dev_python();

    let spawned = Command::new(&python)
        .arg(&script)
        .arg("--port")
        .arg(port.to_string())
        .arg("--token")
        .arg(token)
        .current_dir(&directory)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .spawn();

    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let message = format!("[sidecar] 启动后端失败（{python}）：{error}");
            eprintln!("{message}");
            let _ = app.emit("sidecar-log", message);
            return;
        }
    };

    if let Some(stdout) = child.stdout.take() {
        forward(stdout, app.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        forward(stderr, app.clone());
    }

    let _ = app.emit(
        "sidecar-log",
        format!("[sidecar] 开发模式：{python} {} --port {port}", script.display()),
    );

    if let Some(state) = app.try_state::<SidecarProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(child);
        }
    }
}

/// 打包态：跑 externalBin 里的可执行文件。
fn spawn_bundled(app: &tauri::AppHandle, port: u16, token: &str) -> tauri::Result<()> {
    let command = app
        .shell()
        .sidecar("comsolpilot-sidecar")
        .expect("找不到 comsolpilot-sidecar：检查 tauri.conf.json 的 externalBin 与 binaries/ 目录")
        .args(["--port", &port.to_string(), "--token", token]);

    let (mut receiver, _child) = command.spawn().expect("启动 sidecar 失败");

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            let line = match event {
                CommandEvent::Stdout(bytes) => Some(String::from_utf8_lossy(&bytes).to_string()),
                CommandEvent::Stderr(bytes) => Some(String::from_utf8_lossy(&bytes).to_string()),
                _ => None,
            };
            if let Some(text) = line {
                let _ = app_handle.emit("sidecar-log", text);
            }
        }
    });

    Ok(())
}

/// 退出前结束开发态子进程，避免留下孤儿 Python 进程。
pub fn kill_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<SidecarProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *guard = None;
        }
    }
}
