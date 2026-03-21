# 知库 Agent 交接文档 v1.0

> 面向后续开发 Agent 的全量上下文文档，覆盖项目定位、已完成工作、待开发模块、关键代码位置和注意事项。

---

## 一、项目定位

**知库（Zhiku）** 是一款面向中文用户的本地优先个人知识库助手。

- 主渠道：B站视频（bilibili）
- 核心价值：导入内容 → 自动整理（摘要/标签）→ 本地向量知识库 → 大模型 RAG 问答
- 定位类比：本地版 NotebookLM + 中文内容采集器
- 目标平台：Windows 10/11 x64 桌面端（首版）

### 设计风格要求

- UI：极简、高级、不冗余，深蓝暗色调
- 文案/对话：自然、有判断力，不套模板，不生硬，不幼稚
- 问答：直接给出结论和来源，不重复问题，不伪造引用

---

## 二、技术栈

| 层 | 技术 |
|---|---|
| 桌面端 | Tauri 2 + React 18 + TypeScript + Vite |
| 路由 | React Router v6 |
| 数据请求 | TanStack React Query v5 |
| 后端 | Python 3.11 + FastAPI + Uvicorn |
| 数据库 | SQLite + FTS5 全文搜索 |
| 向量索引 | FAISS |
| Embedding | bge-m3（默认）|
| 大模型接入 | Ollama 本地 + OpenAI 兼容接口（Moonshot/智谱/自定义）|
| ASR | faster-whisper 本地 / OpenAI 兼容 API |
| OCR | PaddleOCR（骨架接入）|
| 运行模式 | Tauri sidecar 启动 Python 服务，监听 localhost:38765 |

---

## 三、项目结构

```
zhiku/
├── AGENTS.md                               # 仓库级协作约束（默认不自动 push）
├── apps/
│   ├── desktop/
│   │   └── src/
│   │       ├── App.tsx                     # 根布局 + 路由 + 侧边栏导航
│   │       ├── styles.css                  # 全局设计系统（已重构，1774 行）
│   │       ├── pages/
│   │       │   ├── StartupPage.tsx         # 首页/启动状态页
│   │       │   ├── LibraryPage.tsx         # 知识库工作台（三栏布局）
│   │       │   ├── ChatPage.tsx            # 智能问答页（SSE 流式）
│   │       │   ├── ContentDetailPage.tsx   # 内容详情页
│   │       │   ├── SettingsPage.tsx        # 设置页
│   │       │   ├── RecycleBinPage.tsx      # 回收站
│   │       │   └── OnboardingPage.tsx      # 首次引导页
│   │       ├── components/
│   │       │   └── ImportPanel.tsx         # 导入面板组件
│   │       └── lib/
│   │           ├── api.ts                  # 所有后端 API 调用封装
│   │           ├── runtime.ts              # Tauri/浏览器运行时检测
│   │           └── language.ts             # 多语言（zh-CN/zh-TW/source）
│   └── web/                                # React + Vite 网页原型入口
├── services/
│   └── api/
│       └── src/zhiku_api/
│           ├── routers/                    # FastAPI 路由层
│           └── services/
│               ├── bilibili_service.py     # B站解析（字幕/元数据/弹幕）
│               ├── llm_gateway.py          # LLM 调用 + 提示词（已优化）
│               ├── chat_service.py         # RAG 问答主逻辑
│               ├── import_service.py       # 导入任务调度
│               ├── file_parse_service.py   # 本地文件解析
│               ├── note_quality_service.py # 笔记质量评分
│               ├── asr_gateway.py          # ASR 转写网关
│               ├── export_service.py       # Markdown 导出
│               └── backup_service.py       # 手动备份
├── scripts/
│   └── dev/
│       ├── start_api.ps1                   # API 启动脚本（默认无 reload）
│       ├── start_web.ps1                   # 网页原型启动脚本（中文路径自动切稳定预览）
│       ├── start_all.ps1                   # 联合启动提示脚本
│       └── pre_push_check.ps1              # 手动 push 前检查进度文档
├── docs/
│   ├── architecture/desktop_runtime.md
│   ├── engineering/知库_协作与进度同步规范_v1.md
│   └── product/
│       ├── 知库_开发进度同步.md
│       └── 知库_开发变更日志.md
├── 知库_交付版需求_v1.1.md
├── 知库_技术实施与开发计划_v1.0.md
└── 已知问题.md
```

---

## 四、已完成的优化工作

### 4.1 styles.css — 设计系统重构

- 文件：`apps/desktop/src/styles.css`
- 原始约 107 行，重构后 1774 行
- 建立完整 CSS 变量体系：色彩、圆角、阴影、动画、布局间距
- 关键变量：
  - `--bg-base: #07101f`（深蓝主背景）
  - `--accent: #4f8ef7`（主色调蓝）
  - `--bilibili: #fb7299`（B站粉）
  - `--success/warning/danger`（状态色）
- 组件体系：按钮（primary/secondary/ghost/danger）、表单、卡片、知识库三栏、问答气泡、首页模块
- 旧类名兼容：`.primary-button`、`.secondary-button`、`.danger-button`、`.button-link` 已做兼容映射

### 4.2 App.tsx — 侧边栏重构

- 添加几何符号图标（⬡◫◎◌⊙），不用 emoji

### 4.2 App.tsx - 侧边栏重构

- 添加几何符号图标，不用 emoji
- 去掉冗余 pill 标签，精简品牌区
- 语言切换改为独立 chip 组（简体/繁体/原文）
- 导航项：首页(状态概览) / 知识库(导入与浏览) / 智能问答(对话与检索) / 回收站 / 设置

### 4.3 StartupPage.tsx - 首页重构

- 顶部状态条：彩色圆点 + 状态文字 + 刷新/停止服务按钮
- Hero 区：标题 + 描述 + 导入视频/开始提问两个 CTA
- 能力卡片 4 格：服务状态 / 内容条数 / 问答模型 / 转写
- 最近导入列表（最多 4 条）
- 未配置模型时展示引导 card 跳转设置页

### 4.4 LibraryPage.tsx - 文案与布局

- 三栏布局：左栏(导入面板+概览) / 中栏(内容列表) / 右栏(选中内容预览)
- 描述文字改为 B 站场景
- 内容列表标题改为「全部内容」
- 筛选 tab：全部 / 视频 / 网页 / 问答

### 4.5 ChatPage.tsx - 建议问题

建议问题改为 B 站用户真实习惯：
- 这个视频主要讲了什么，核心结论是什么？
- UP 主提到了哪些具体方法或步骤？
- 这里有哪些观点我可以直接用？
- 帮我找出最值得二刷的片段

### 4.6 llm_gateway.py - 提示词优化

- system_prompt：帮用户理解和提炼内容的助手，回答直接自然，有判断力，不套模板
- temperature 从 0.2 调整为 0.25
- 多资料检索：去掉 12 条规则列表，改为自然指令
- 单内容问答：标注内容类型（B站视频/ASR转写等），更有上下文感

---

## 五、核心数据流

### B站导入链路

```
用户粘贴链接
  -> POST /api/v1/imports/url
  -> BilibiliService (CC字幕 > AI字幕 > ASR转写，三级降级)
  -> TranscriptSegment[]
  -> LlmGateway (摘要/要点/精炼笔记)
  -> NoteQualityService (质量评分)
  -> SQLite contents 表 + FTS5 索引
  -> 文本切块 -> Embedding -> FAISS 索引
  -> 返回 content_id
```

### RAG 问答链路

```
用户输入问题
  -> ChatService
  -> query embedding
  -> FAISS Top-K 向量检索
  -> FTS5 关键词检索
  -> 融合排序 (RRF)
  -> 构建 prompt (system + context chunks + user question)
  -> LlmGateway -> SSE 流式输出
  -> 前端 EventSource 接收，实时渲染
  -> 底部展示 citations（content_id + snippet + chunk_index）
```

### 字幕获取降级策略

1. CC 官方字幕（最优，直接结构化）
2. AI 字幕（B 站 AI 生成）
3. ASR 本地转写（faster-whisper，无字幕时触发）
4. 失败：记录 status=needs_asr 或 asr_failed，前端提示

---

## 六、待开发模块（优先级排序）

### P0 - 阻塞主链路

| 模块 | 位置 | 说明 |
|---|---|---|
| ContentDetailPage | `apps/desktop/src/pages/ContentDetailPage.tsx` | 内容详情页，需展示原文/摘要/标签/引用锚点/操作按钮 |
| 引用跳转 | `ChatPage.tsx` + `ContentDetailPage.tsx` | 问答引用点击后跳到详情页并定位到对应段落 |
| ImportPanel 状态流 | `apps/desktop/src/components/ImportPanel.tsx` | 导入进度状态机展示（pending/parsing/summarizing/done/failed）|

### P1 - 完整性功能

| 模块 | 位置 | 说明 |
|---|---|---|
| SettingsPage | `apps/desktop/src/pages/SettingsPage.tsx` | 模型配置引导体验优化，检测 Ollama 状态 |
| OnboardingPage | `apps/desktop/src/pages/OnboardingPage.tsx` | 首次启动引导流程，选目录+配模型 |
| 全文搜索联动 | `LibraryPage.tsx` | 搜索框实时查询 FTS5，高亮匹配词 |
| Markdown 导出 | `ContentDetailPage.tsx` | 单条内容导出 Markdown 按钮 |

### P2 - 体验增强

| 模块 | 说明 |
|---|---|
| 多轮对话历史 | 问答 session 持久化，侧边栏可切换历史会话 |
| 内容手动编辑 | 详情页支持编辑标题/摘要/标签 |
| 标签筛选 | LibraryPage 增加标签点击筛选 |
| 弹幕数据接入 | BilibiliService 已预留，补充弹幕采样存储 |

### P3 - 后续版本

- PDF/图片 OCR 完整接入（骨架已有）
- 网页正文提取（WebpageService 已有）
- 小红书/抖音解析
- macOS/Linux 打包
- 云同步/WebDAV

---

## 七、关键代码位置速查

### 后端

| 功能 | 文件 | 关键函数/类 |
|---|---|---|
| B站解析入口 | services/api/src/zhiku_api/services/bilibili_service.py | BilibiliService |
| LLM调用+提示词 | services/api/src/zhiku_api/services/llm_gateway.py | LlmGateway |
| RAG问答主逻辑 | services/api/src/zhiku_api/services/chat_service.py | ChatService |
| 导入任务调度 | services/api/src/zhiku_api/services/import_service.py | ImportService |
| ASR转写 | services/api/src/zhiku_api/services/asr_gateway.py | AsrGateway |
| 笔记质量评分 | services/api/src/zhiku_api/services/note_quality_service.py | NoteQualityService |
| Markdown导出 | services/api/src/zhiku_api/services/export_service.py | ExportService |

### 前端

| 功能 | 文件 | 说明 |
|---|---|---|
| 全部API调用 | apps/desktop/src/lib/api.ts | 统一封装，修改接口从这里入手 |
| 运行时检测 | apps/desktop/src/lib/runtime.ts | isTauriRuntime(), ensureApiReady() |
| 多语言 | apps/desktop/src/lib/language.ts | useLanguage(), displayText() |
| 设计系统 | apps/desktop/src/styles.css | CSS变量 + 全部组件样式 |

---

## 八、API 端点速查

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/v1/health | 健康检查 |
| GET | /api/v1/system/status | 模型状态/服务状态 |
| POST | /api/v1/imports/url | 导入URL |
| POST | /api/v1/imports/file | 导入本地文件 |
| GET | /api/v1/imports/{job_id} | 查询导入任务状态 |
| GET | /api/v1/contents | 内容列表（支持搜索）|
| GET | /api/v1/contents/{id} | 内容详情 |
| PATCH | /api/v1/contents/{id} | 更新标题/摘要/标签 |
| DELETE | /api/v1/contents/{id} | 移入回收站 |
| POST | /api/v1/chat/stream | RAG问答（SSE流式）|
| GET | /api/v1/settings | 获取设置 |
| PUT | /api/v1/settings | 保存设置 |
| POST | /api/v1/backups | 手动备份 |
| POST | /api/v1/contents/upgrade | 旧内容升级 |

---

## 九、已知问题与限制

- rustc/cargo 未安装 → tauri build 无法执行，需先装 Rust 工具链
- ollama 未安装 → 本地模型不可用，设置页提示待配置
- B站解析：多分P、需登录内容、私有视频可能失败
- FAISS/Embedding 以骨架接入为主，未做性能调优
- OCR 模块骨架存在，PaddleOCR 未完整集成
- sidecar 打包需本机安装 PyInstaller
- 仓库路径若含中文或其他非 `ASCII` 字符，例如 `D:\桌面\zhiku`，直接跑 `Vite dev` 可能白屏；优先使用 `scripts/dev/start_web.ps1` 自动切到稳定预览模式

---

## 十、开发环境启动

### 10.1 推荐脚本启动方式

```powershell
# API（默认无 reload，更稳定）
powershell -ExecutionPolicy Bypass -File .\scripts\dev\start_api.ps1

# 网页原型（中文路径自动切换到 build + preview）
powershell -ExecutionPolicy Bypass -File .\scripts\dev\start_web.ps1

# 联合启动提示
powershell -ExecutionPolicy Bypass -File .\scripts\dev\start_all.ps1
```

说明：

- 网页原型默认访问地址为 `http://127.0.0.1:4173/`
- 如果需要显式调试 `FastAPI` 热重载，可在 `start_api.ps1` 基础上自行加 `-Reload`
- 当前本地网页验证优先走稳定预览模式，而不是直接依赖 `Vite dev`

### 10.2 手动命令启动方式

```powershell
# 后端
cd services/api
pip install -e .
uvicorn zhiku_api.main:app --host 127.0.0.1 --port 38765

# 网页原型（ASCII 路径下可直接开发）
cd apps/web
npm install
npm run dev

# 完整桌面端（需 Rust + Cargo）
cd apps/desktop
npm install
npm run tauri:dev
```

### 10.3 协作与手动推送约束

- 高层阶段进度维护在 `docs/product/知库_开发进度同步.md`
- 每一轮实际落地修改维护在 `docs/product/知库_开发变更日志.md`
- 仓库协作规范维护在 `docs/engineering/知库_协作与进度同步规范_v1.md`
- 默认流程是“改动 -> 验证 -> 更新变更日志 -> 用户手动 commit / push”
- 用户准备手动推送前，优先执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev\pre_push_check.ps1
```

---

## 十一、下一步建议行动

1. **先跑通 ContentDetailPage** — 问答引用跳转的终点，当前缺少完整实现
2. **ImportPanel 进度状态** — 导入时用户看不到进度，优先补全状态机展示
3. **问答引用可点击** — ChatPage citations 点击后跳详情页并定位段落
4. **SettingsPage 模型检测** — Ollama检测 + 首次配置引导，降低上手门槛
5. **打包环境搭建** — 安装 Rust 工具链 + PyInstaller，走通端到端打包流程

---

## 十二、设计系统快速参考

```css
/* 色彩变量 */
--bg-base: #07101f
--bg-surface: #0d1b2e
--bg-card: #111f35
--accent: #4f8ef7
--bilibili: #fb7299
--success: #22c55e
--warning: #f59e0b
--danger: #ef4444

/* 常用按钮类 */
.btn.btn-primary     /* 主要操作 */
.btn.btn-secondary   /* 次要操作 */
.btn.btn-ghost       /* 轻量操作 */
.btn.btn-danger      /* 危险操作 */

/* 常用布局类 */
.page                /* 页面容器 */
.card.glass-panel    /* 毛玻璃卡片 */
.pill                /* 小标签 */
.eyebrow             /* 小标题/章节标记 */
.muted-text          /* 次要文字 */
```

---

## 十三、UI 主题升级（v2 -> v3，浅色文档风）

### 色彩系统变更

原深蓝暗色主题已升级为飞书风格浅色纸质主题：

| 变量 | 旧值 | 新值 |
|---|---|---|
| --bg-base | #07101f | #f5f5f2 |
| --bg-surface | #0d1a2d | #ffffff |
| --bg-elevated | #132238 | #f0f0ed |
| --text-primary | #eaf0fb | #1a1a18 |
| --text-secondary | #8da4c4 | #646462 |
| --accent | #4f8ef7 | #376ee6 |
| --bilibili | #fb7299 | #e4527a |

### 新增批注/高亮 CSS 变量

```css
--highlight-yellow / --highlight-yellow-border
--highlight-blue   / --highlight-blue-border
--highlight-green  / --highlight-green-border
--annotation-bg / --annotation-border / --annotation-text
```

### 新增 CSS 组件类

- `.segment-highlight-yellow/blue/green` — 证据片段高亮
- `.annotation-bubble` / `.annotation-input` — 批注气泡
- `.highlight-picker` / `.highlight-dot` — 高亮颜色选择器
- `.annotation-trigger` — 批注触发按钮
- `.inline-edit-field` / `.detail-title-input` / `.detail-summary-input` — 内联编辑
- `.tag-edit-row` / `.tag-edit-chip` / `.tag-add-input` — 标签编辑
- `.inline-save-bar` — 保存操作栏

---

## 十四、ContentDetailPage 新增功能

### 14.1 内联编辑（飞书风格）

- 标题点击进入编辑模式，失焦自动保存
- 摘要点击进入多行编辑
- 标签支持点击 × 删除单个，输入框回车/逗号添加新标签
- 右上角「编辑/保存」按钮切换模式
- 状态：`isEditingMeta: boolean`

### 14.2 证据片段批注（localStorage 持久化）

- 每个 transcript 片段支持 3 色高亮（黄/蓝/绿）
- 每个片段支持文字批注，悬停显示选项
- 批注和高亮存储在 `localStorage` key `annotations:{contentId}`
- 核心 hook：`setAnnotation(index, patch)` — 合并更新，空时自动清除
- 数据结构：`Record<number, { highlight: HighlightColor; note: string }>`

### 14.3 注意事项

- 批注目前仅存 localStorage，刷新不丢失但换设备丢失
- 后续可考虑通过 PATCH /api/v1/contents/{id} 的 metadata 字段持久化到后端
- `HighlightColor` 类型：`"yellow" | "blue" | "green" | ""`
