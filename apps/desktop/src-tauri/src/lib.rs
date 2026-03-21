use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{path::BaseDirectory, AppHandle, Manager, State};

#[derive(Serialize)]
struct RuntimeInfo {
    app_name: String,
    app_version: String,
    sidecar_mode: String,
}

#[derive(Serialize)]
struct SidecarStatus {
    started: bool,
    pid: Option<u32>,
    mode: String,
    command: String,
}

struct AppRuntimeState {
    sidecar: Mutex<Option<Child>>,
}

impl Default for AppRuntimeState {
    fn default() -> Self {
        Self {
            sidecar: Mutex::new(None),
        }
    }
}

#[tauri::command]
fn ping() -> String {
    "pong".into()
}

#[tauri::command]
fn get_runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        app_name: "知库".into(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        sidecar_mode: if cfg!(debug_assertions) {
            "python-fastapi-sidecar".into()
        } else {
            "bundled-sidecar".into()
        },
    }
}

#[tauri::command]
fn get_sidecar_state(state: State<AppRuntimeState>) -> Result<SidecarStatus, String> {
    let mut guard = state.sidecar.lock().map_err(|_| "无法读取 sidecar 状态")?;

    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                Ok(SidecarStatus {
                    started: false,
                    pid: None,
                    mode: "stopped".into(),
                    command: "sidecar 已退出".into(),
                })
            }
            Ok(None) => Ok(SidecarStatus {
                started: true,
                pid: Some(child.id()),
                mode: if cfg!(debug_assertions) {
                    "python-fastapi-sidecar".into()
                } else {
                    "bundled-sidecar".into()
                },
                command: "sidecar 已启动".into(),
            }),
            Err(error) => Err(format!("读取 sidecar 状态失败: {error}")),
        }
    } else {
        Ok(SidecarStatus {
            started: false,
            pid: None,
            mode: "stopped".into(),
            command: "当前尚未启动 sidecar".into(),
        })
    }
}

#[tauri::command]
fn start_api_sidecar(app: AppHandle, state: State<AppRuntimeState>) -> Result<SidecarStatus, String> {
    let mut guard = state.sidecar.lock().map_err(|_| "无法获取 sidecar 锁")?;

    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                return Ok(SidecarStatus {
                    started: true,
                    pid: Some(child.id()),
                    mode: if cfg!(debug_assertions) {
                        "python-fastapi-sidecar".into()
                    } else {
                        "bundled-sidecar".into()
                    },
                    command: "sidecar 已在运行".into(),
                });
            }
            Ok(Some(_)) => {
                *guard = None;
            }
            Err(error) => {
                return Err(format!("检测 sidecar 进程失败: {error}"));
            }
        }
    }

    let (mut command, mode, command_text) = build_sidecar_command(&app)?;
    let child = command
        .spawn()
        .map_err(|error| format!("启动 API sidecar 失败: {error}"))?;
    let pid = child.id();
    *guard = Some(child);

    Ok(SidecarStatus {
        started: true,
        pid: Some(pid),
        mode,
        command: command_text,
    })
}

#[tauri::command]
fn stop_api_sidecar(state: State<AppRuntimeState>) -> Result<SidecarStatus, String> {
    let mut guard = state.sidecar.lock().map_err(|_| "无法获取 sidecar 锁")?;

    if let Some(mut child) = guard.take() {
        child.kill().map_err(|error| format!("停止 sidecar 失败: {error}"))?;
        let _ = child.wait();
        return Ok(SidecarStatus {
            started: false,
            pid: None,
            mode: "stopped".into(),
            command: "sidecar 已停止".into(),
        });
    }

    Ok(SidecarStatus {
        started: false,
        pid: None,
        mode: "stopped".into(),
        command: "当前没有运行中的 sidecar".into(),
    })
}

fn build_sidecar_command(app: &AppHandle) -> Result<(Command, String, String), String> {
    if cfg!(debug_assertions) {
        let repo_root = repo_root();
        let api_src = repo_root.join("services").join("api").join("src");
        let mut command = Command::new("python");
        command
            .arg("-m")
            .arg("uvicorn")
            .arg("zhiku_api.main:app")
            .arg("--app-dir")
            .arg(&api_src)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg("38765")
            .current_dir(&repo_root)
            .env("PYTHONPATH", &api_src)
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        return Ok((
            command,
            "python-fastapi-sidecar".into(),
            format!(
                "python -m uvicorn zhiku_api.main:app --app-dir {} --host 127.0.0.1 --port 38765",
                api_src.display()
            ),
        ));
    }

    let current_exe = std::env::current_exe().map_err(|error| format!("读取当前程序路径失败: {error}"))?;
    let executable_dir = current_exe
        .parent()
        .ok_or_else(|| "无法定位桌面程序目录".to_string())?;

    let mut candidates = vec![
        executable_dir.join("zhiku-service.exe"),
        executable_dir.join("sidecars").join("zhiku-service.exe"),
        executable_dir.join("resources").join("zhiku-service.exe"),
    ];

    if let Ok(resource_path) = app.path().resolve("zhiku-service.exe", BaseDirectory::Resource) {
        candidates.insert(0, resource_path);
    }

    for candidate in candidates {
        if candidate.exists() {
            let mut command = Command::new(&candidate);
            command.stdout(Stdio::null()).stderr(Stdio::null());
            return Ok((
                command,
                "bundled-sidecar".into(),
                candidate.display().to_string(),
            ));
        }
    }

    Err("未找到打包后的 zhiku-service.exe，请先执行 sidecar 构建脚本。".into())
}

fn repo_root() -> PathBuf {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    base.join("..").join("..").canonicalize().unwrap_or(base)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            ping,
            get_runtime_info,
            get_sidecar_state,
            start_api_sidecar,
            stop_api_sidecar
        ])
        .run(tauri::generate_context!())
        .expect("error while running zhiku desktop application");
}
