# Tauri Bundled Resources

这个目录用于存放打包到桌面安装包中的额外资源。

当前重点资源：

- `zhiku-service.exe`：由 `scripts/build/build_sidecar.ps1` 构建并复制到此目录

Tauri 构建时会通过 `bundle.resources` 将该文件打到应用资源目录中，供 release 模式自动启动。
