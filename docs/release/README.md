# 发布说明占位

后续在此补充：

- 安装包产物
- 升级说明
- 已知问题
- 回滚说明

## 当前构建链路

1. 执行 `scripts/build/check_env.ps1 -Profile bundle`
2. 执行 `scripts/build/build_sidecar.ps1`
3. 生成 `dist/sidecar/zhiku-service.exe`
4. 自动复制到 `apps/desktop/src-tauri/resources/zhiku-service.exe`
5. 执行 `scripts/build/build_desktop.ps1`
6. 调用 `npm run tauri:build` 打包桌面安装包

## 发布前检查

- 检查清单：`docs/release/release_checklist.md`
- 安装说明：`docs/release/安装说明.md`
- 变更记录：`CHANGELOG.md`
- 已知问题：`已知问题.md`
