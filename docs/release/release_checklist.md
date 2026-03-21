# 发布检查清单

## 1. 构建前环境

- [ ] `python --version` 正常
- [ ] `python -m pip --version` 正常
- [ ] `node -v` 正常
- [ ] `npm -v` 正常
- [ ] `rustc -V` 正常
- [ ] `cargo -V` 正常
- [ ] `scripts/build/check_env.ps1 -Profile bundle` 通过

## 2. Python sidecar

- [ ] `powershell -ExecutionPolicy Bypass -File .\scripts\build\build_sidecar.ps1` 成功
- [ ] 生成 `dist/sidecar/zhiku-service.exe`
- [ ] 已复制到 `apps/desktop/src-tauri/resources/zhiku-service.exe`
- [ ] 启动 sidecar 后 `GET /api/v1/health` 返回 200

## 3. 桌面端构建

- [ ] `cd apps/desktop && npm install` 成功
- [ ] `npm run tauri:build` 成功
- [ ] 生成 Windows 安装包或可执行产物

## 4. 核心功能回归

- [ ] 启动页可自动检测或拉起 API sidecar
- [ ] 首次引导页可读取模型状态
- [ ] 可以导入 B 站链接
- [ ] 可以导入 `DOCX/TXT/MD`
- [ ] 知识库列表、搜索、详情页可用
- [ ] 内容编辑、删除、恢复可用
- [ ] Markdown 导出可用
- [ ] 手动备份可用
- [ ] 诊断包导出可用
- [ ] AI 问答可返回 citations

## 5. 安装包验收

- [ ] 干净环境可以安装
- [ ] 首次启动不会卡死
- [ ] 卸载流程正常
- [ ] 卸载后用户数据目录策略明确

## 6. 发布资料

- [ ] `CHANGELOG` 已更新
- [ ] `已知问题` 已更新
- [ ] 用户安装说明已更新
- [ ] 内测说明或发布说明已更新
