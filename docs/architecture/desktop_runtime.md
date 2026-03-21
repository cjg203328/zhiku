# Desktop Runtime

`知库` 当前采用 `Tauri + React + FastAPI sidecar` 的桌面运行时结构：

- `apps/desktop/src-tauri`：桌面壳、窗口生命周期、后续 Rust 命令入口
- `apps/desktop/src`：React 前端 UI
- `services/api`：Python sidecar，本地解析、存储、问答都在这里完成

## 当前状态

- `src-tauri/Cargo.toml` 已补齐为标准 `Tauri 2` Rust 工程
- `src-tauri/capabilities/default.json` 已启用 `core:default`
- `src-tauri/src/lib.rs` 已提供 `ping`、`get_runtime_info`、`start_api_sidecar`、`stop_api_sidecar` 等命令
- 启动页会优先检测 `127.0.0.1:38765`，若当前是 `Tauri` 运行时且 API 未启动，则自动尝试拉起 `python -m uvicorn`

## Dev 模式 sidecar 机制

开发模式下，桌面壳会自动尝试执行：

```text
python -m uvicorn zhiku_api.main:app --app-dir services/api/src --host 127.0.0.1 --port 38765
```

并自动注入：

- `current_dir = 仓库根目录`
- `PYTHONPATH = services/api/src`

## Release 模式说明

当前已预留 release 模式 sidecar 启动逻辑，默认会查找：

- `$RESOURCE/zhiku-service.exe`
- `zhiku-service.exe`
- `sidecars/zhiku-service.exe`
- `resources/zhiku-service.exe`

后续需要结合打包流程把 sidecar 放到安装包内。

## 打包集成

- `scripts/build/build_sidecar.ps1`：使用 `PyInstaller` 构建 `zhiku-service.exe`
- `scripts/build/build_desktop.ps1`：先构建 sidecar，再执行 `npm run tauri:build`
- `src-tauri/tauri.conf.json`：通过 `bundle.resources` 将 `resources/zhiku-service.exe` 打进安装包

## 后续建议

- 接入 sidecar 进程启动与健康检查
- 将日志目录和知识库目录通过 Rust 命令暴露给前端
- 增加安装包签名、版本号注入与构建流水线
