# Changelog

## [Unreleased]

### Added

- Windows 桌面端 `Tauri + React` 基础工程
- Python sidecar `FastAPI` 本地服务
- 内容导入、知识库列表、详情编辑、回收站、导出、备份
- 本地检索问答与引用跳转
- B站真实解析第一版与失败降级
- sidecar 自动启动、诊断包导出、模型状态检测
- sidecar 打包脚本、桌面打包脚本、环境自检脚本
- 仓库级 `AGENTS.md` 协作约束与进度同步规范文档
- `docs/product/知库_开发进度同步.md` 与 `docs/product/知库_开发变更日志.md` 双层进度文档
- 手动推送前检查脚本 `scripts/dev/pre_push_check.ps1`

### Changed

- 将 PRD 收敛为可交付 Windows 桌面端范围
- 将构建链路调整为 `sidecar -> Tauri bundle`
- 默认协作流程调整为“修改 -> 验证 -> 更新变更日志 -> 用户手动 commit / push”
- 本地网页原型改为优先支持稳定预览启动，规避中文路径下 `Vite @fs` 编码导致的白屏
- API 启动脚本默认采用非 `reload` 模式，降低 Windows 本地环境卡死概率
- 项目分析与交接对照文档的主文件名统一到 `知库` 语境

### Known

- 当前尚未在本机完成 `Tauri` 正式构建验证
- `Rust/Cargo` 缺失时，桌面安装包无法构建
- `Ollama` 未安装时，本地模型能力不可用
- 仓库位于非 `ASCII` 路径时，不建议直接依赖 `Vite dev`，优先使用 `scripts/dev/start_web.ps1`
