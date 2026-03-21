# 知库改进 Agent 交接文档：对照 KnowNote

## 0. 文档目的

这份文档给后续参与 `知库` 改造或对照分析的 agent 使用，目标不是重复介绍两个项目的 README，而是回答下面四个问题：

1. `知库` 当前已经实现了哪些对 `KnowNote` 有迁移价值的能力。
2. `KnowNote` 当前的架构边界是什么，哪些地方可以改，哪些地方不该硬搬。
3. 如果要把 `知库` 的实现逻辑迁到 `KnowNote`，推荐从哪几层下手。
4. 多个 agent 并行时，怎么拆分写入范围，避免互相踩文件。

---

## 1. 本次分析范围

- 本地项目：`D:\桌面\zhiku`
- 对照仓库：`D:\桌面\zhiku\.tmp_external\KnowNote`
- 远端来源：`https://github.com/MrSibe/KnowNote`
- 分析时间：`2026-03-20`

本次结论基于以下内容整理：

- `知库` 的前端、FastAPI sidecar、SQLite repository、导入/问答/质量评估链路。
- `KnowNote` 的 Electron main/preload/renderer、SQLite/Drizzle schema、KnowledgeService、向量检索和多 provider 抽象。

---

## 2. 一页结论

如果只看一句话：

`KnowNote` 已经有更完整的桌面端产品骨架、Notebook 容器、向量化和派生资源体系；`知库` 则在“采集质量治理、弱材料兜底、异步导入可观测、旧内容升级修复、问答反馈可解释”这几个环节明显更成熟。

所以推荐的改造方向不是：

- 把 `知库` 的扁平 `content` 模型整体替换 `KnowNote`。

而是：

- 保留 `KnowNote` 的 `Notebook -> Document -> Chunk -> Embedding -> Item` 主结构，
- 把 `知库` 的“导入质量层”和“问答反馈层”嵌入进去，
- 让 `KnowNote` 从“能导入、能搜、能聊”升级成“知道当前材料质量如何、知道什么时候该保守回答、知道怎么补齐证据层”的产品。

一句更具体的实施建议：

- `P0` 先补 `导入任务可观测 + 文档质量模型 + 弱材料兜底`。
- `P1` 再补 `问答反馈解释 + 时间片段/seek 定位 + 旧内容升级修复`。
- `P2` 再考虑把这套质量元数据向 `MindMap / Quiz / Anki` 派生链路扩散。

---

## 3. 两个项目的心智模型

### 3.1 知库：内容卡片中心

`知库` 的核心不是 Notebook，而是单条 `content`。

一条 `content` 里会尽量包含：

- 来源信息：`source_url`、`source_file`、`platform`
- 正文层：`content_text`
- 精炼层：`summary`、`key_points`、`note_markdown/refined_note_markdown`
- 证据层：`transcript_segments`、`semantic_transcript_segments`
- 检索层：`content_chunks` + FTS
- 质量层：`note_quality`
- 维护层：`import_jobs`、`upgrade/reparse`

它更像“面向问答和验证的一张知识卡片”，而不是一个通用笔记本容器。

### 3.2 KnowNote：笔记本容器中心

`KnowNote` 的核心是 `Notebook`。

在一个 notebook 下，主要资源有：

- `documents`
- `notes`
- `chat_sessions`
- `chunks`
- `embeddings`
- `mind_maps`
- `quizzes`
- `anki_cards`
- `items`

它的心智模型更接近：

- Notebook 是工作空间
- Document 是知识来源
- Note / MindMap / Quiz / Anki 是派生产物
- Chat 是围绕 notebook 的长期交互层

这个模型比 `知库` 更适合扩展，但目前在“单条来源质量治理”上没有 `知库` 做得细。

---

## 4. 知库当前实现摘要

### 4.1 技术栈与结构

- 前端：`apps/desktop`，React + Vite + React Query + Tiptap + Zustand
- Web 壳：`apps/web`，实际上复用 `apps/desktop/src/App.tsx`
- 后端：`services/api`，FastAPI
- 存储：SQLite，repository 模式
- 运行方式：桌面端前端 + 本地 sidecar API

### 4.2 核心链路

#### 导入链路

入口：

- `services/api/src/zhiku_api/routers/imports.py`

核心服务：

- `services/api/src/zhiku_api/services/import_service.py`
- `services/api/src/zhiku_api/services/file_parse_service.py`
- `services/api/src/zhiku_api/repositories/library_repository.py`

处理流程大致是：

1. 路由层创建异步导入任务 `import_job`
2. 先给前端一个 `pending preview`
3. 后台任务执行解析
4. 导入结果进入统一增强流水线：
   - `InitialMaterialService.prepare`
   - `LlmGateway.enhance_import_result`
   - `ContentTermService.extract`
   - `NoteQualityService.evaluate`
5. 最终写入 `contents` 和 `content_chunks`
6. 前端轮询 job，直到导入结束

这个链路的关键优点不是“抓得多”，而是“即使抓不完整，也能给用户一个明确状态和下一步动作”。

#### 问答链路

入口：

- `services/api/src/zhiku_api/routers/chat.py`

核心服务：

- `services/api/src/zhiku_api/services/chat_service.py`

特点：

- 不只跑一次检索，而是先构造 `query_variants`
- 同时查 `content` 和 `chunk`
- 支持 scoped 问答和全库问答
- 会根据 `note_quality`、采集状态、上下文承接情况调整回答方式
- 会返回 `quality` 和 `retrieval` 元数据给前端

这意味着前端不只是拿到答案文本，还能知道：

- 这轮回答到底是基于什么证据得出的
- 检索路径是“全库混合”还是“单条聚焦”
- 当前回答是否应该保守使用

#### 维护链路

入口：

- `services/api/src/zhiku_api/routers/contents.py`

核心服务：

- `services/api/src/zhiku_api/services/content_upgrade_service.py`

作用：

- 给旧内容补 `content_terms`
- 给旧内容补 `note_quality`
- 补 `seek_url`
- 对半成品内容重新抓取
- 重抓失败时回退到“本地修复”

这条链路非常适合迁到 `KnowNote`，因为 `KnowNote` 现在已经有 document/chunk/vector 基础，但缺少“老数据自动补齐”的概念。

### 4.3 知库里最值得迁移的三个逻辑

#### A. 弱材料兜底

对应实现：

- `services/api/src/zhiku_api/services/initial_material_service.py`

核心思想：

- 如果当前来源还不完整，不要直接给空白 document
- 先用标题、描述、已拿到的提示信息生成“初步材料整理”
- 同时生成首批可提问的问题

这会显著降低“导入成功了但用户什么也看不到”的空窗。

#### B. 质量评估不是单一分数，而是多维 readiness

对应实现：

- `services/api/src/zhiku_api/services/note_quality_service.py`

它不是只给一个 `score`，而是同时评估：

- capture
- refined_note
- raw_evidence
- retrieval
- time_jump
- understanding

然后再得出：

- `double_note_ready`
- `time_jump_ready`
- `retrieval_ready`
- `question_answer_ready`
- `agent_ready`

这套思路很适合迁到 `KnowNote`，因为 `KnowNote` 现在的 document status 只有比较粗的 `pending / processing / indexed / failed`。

#### C. 问答结果可解释

对应实现：

- `services/api/src/zhiku_api/services/chat_service.py`
- `apps/desktop/src/pages/ChatPage.tsx`

回答后不仅返回：

- `answer`
- `citations`

还返回：

- `quality`
- `retrieval`
- `mode`

前端据此展示：

- 当前回答可信度
- 检索路径
- 是否使用会话上下文
- 是否命中了主内容
- 是否建议先补 Cookie/ASR/模型配置

这非常像一个“面向真实使用者的 RAG 解释层”。

---

## 5. KnowNote 当前实现摘要

### 5.1 技术栈与结构

- 主进程：Electron + TypeScript
- 前端：React + Zustand + React Router
- 数据库：SQLite + Drizzle
- 向量：sqlite-vec
- Provider：AI SDK 风格抽象
- 富文本：Tiptap

### 5.2 架构分层

#### main process

关键文件：

- `src/main/index.ts`
- `src/main/ipc/*.ts`
- `src/main/services/*.ts`
- `src/main/providers/*.ts`
- `src/main/db/*.ts`
- `src/main/vectorstore/*.ts`

职责：

- 初始化数据库和向量存储
- 初始化 provider manager
- 注册 IPC
- 处理真正的知识导入、检索、会话和派生资源生成

#### preload

关键文件：

- `src/preload/index.ts`

职责：

- 把 Electron IPC 暴露成 renderer 可调用的 API

#### renderer

关键文件：

- `src/renderer/src/App.tsx`
- `src/renderer/src/components/notebook/NotebookLayout.tsx`
- `src/renderer/src/store/*.ts`

职责：

- notebook 列表
- 三栏 notebook 工作台
- chat、knowledge、mindmap、quiz、anki 各自的 store 和 UI

### 5.3 当前最重要的数据模型

对应：

- `src/main/db/schema.ts`

核心实体关系可以这么记：

- `notebooks` 是容器
- `documents` 是来源
- `chunks` 是最小检索单元
- `embeddings` 是向量元数据
- `notes / mind_maps / quizzes / anki_cards` 是派生资源
- `items` 是 notebook 内统一展示层
- `chat_sessions / chat_messages` 是会话层

### 5.4 当前知识导入链路

核心文件：

- `src/main/services/KnowledgeService.ts`
- `src/main/services/FileParserService.ts`
- `src/main/services/ChunkingService.ts`
- `src/main/services/EmbeddingService.ts`
- `src/main/vectorstore/SQLiteVectorStore.ts`

大致流程：

1. 解析来源内容
2. 创建 `document`
3. 分块
4. 生成 embedding
5. 写入向量表
6. 更新 document 状态为 `indexed`

这是一个标准、清晰、可维护的本地 RAG 管线。

### 5.5 当前已经具备、无需重做的能力

这部分要明确，不然很容易重复造轮子。

`KnowNote` 已经做得不错的点：

- 主进程和 renderer 分层清楚
- `FileParserService` 使用 loader 模式，扩展新来源很自然
- `documents/chunks/embeddings/items` schema 设计完整
- 有本地文件拷贝和删除逻辑
- provider 抽象已经成型
- 向量检索路径已经通了
- `MindMap / Quiz / Anki` 这些派生资源结构已经有地方挂载

所以迁移 `知库` 能力时，应该优先利用这些现成结构，而不是绕开它们新搭一套。

---

## 6. 两个项目的结构映射

### 6.1 可类比关系

| 知库概念 | KnowNote 中最接近的承载位置 | 备注 |
| --- | --- | --- |
| `content` | `document + document.metadata` | 不是完全等价，但最适合承载 |
| `content_chunks` | `chunks` | `KnowNote` 已有 chunk 表，只缺更丰富 metadata |
| `note_quality` | `documents.metadata.quality` | 建议先放 metadata，后期再决定是否拆表 |
| `import_jobs` | 暂无 | 推荐新增 persisted job 层 |
| `chat_note` | `notes + items` | 可以做成“从回答沉淀为 note item” |
| `semantic_transcript_segments` | `documents.metadata` 或 `chunks.metadata` | 取决于是否要保留段级时间信息 |
| `content_terms` | `documents.metadata.terms` | 很适合作为冷启动检索和 UI 标签 |

### 6.2 明确不要直接照搬的地方

不要做下面这些事：

- 不要把 `KnowNote` 的 `Notebook` 容器模型改成 `知库` 的扁平内容库模型。
- 不要用 `contents` 思路替换 `documents + items + notes` 的组合。
- 不要把 `note_quality` 直接做成向量检索分数。
- 不要让导入必须依赖 LLM 才能完成。
- 不要把 B 站或音频逻辑写死进通用 loader，本质上它应该是 source-specific enrichment。

---

## 7. 推荐迁移到 KnowNote 的改进点

下面按优先级排序。

### 7.1 P0：补“导入任务可观测”

#### 为什么要先做

`KnowNote` 现在的索引过程是存在进度概念的，但更偏内存态和即时流程；`知库` 已经证明：

- 持久化导入 job
- 明确 step
- 支持重试/补强

会显著提升“可用性”和“可维护性”。

#### 推荐落点

- `src/main/db/schema.ts`
- `src/main/db/migrations/*`
- `src/main/services/KnowledgeService.ts`
- `src/main/ipc/knowledgeHandlers.ts`
- `src/preload/index.ts`
- `src/renderer/src/store/knowledgeStore.ts`

#### 推荐能力

- 新增 `document_jobs` 或 `import_jobs`
- job 状态至少包含：
  - `queued`
  - `parsing`
  - `chunking`
  - `embedding`
  - `saving`
  - `completed`
  - `failed`
- renderer 端可以轮询或监听 job 进度
- 失败 job 支持 retry

### 7.2 P0：给 document 增加“质量层”

#### 为什么要做

`KnowNote` 现在知道“有没有建好索引”，但不知道“这条来源能不能直接拿来稳定问答”。

`知库` 的成熟点在于把“能不能问、能不能回看、能不能当最终笔记”拆开判断。

#### 推荐落点

- 新增服务：`src/main/services/DocumentQualityService.ts`
- 接入位置：`src/main/services/KnowledgeService.ts`
- 存储位置：`documents.metadata.quality`

#### 第一版建议字段

- `score`
- `level`
- `label`
- `summary`
- `recommendedAction`
- `retrievalReady`
- `questionAnswerReady`
- `timeJumpReady`
- `understandingReady`
- `rawEvidenceReady`
- `dimensions`

#### 重点

第一版不用追求和 `知库` 完全一致，但思路要一致：

- 不只给一个分数
- 要给“为什么当前是这个状态”
- 要给“用户下一步该做什么”

### 7.3 P0：补“弱材料兜底”

#### 为什么要做

弱来源最伤人的不是“质量差”，而是“空白”。

`知库` 的 `InitialMaterialService` 做的事情很适合迁移：

- 用标题、描述、当前可用材料，先产出 seed markdown
- 给出首批 seed queries
- 明确当前只是弱材料，不假装完整

#### 推荐落点

- 新增服务：`src/main/services/InitialMaterialService.ts`
- 接入位置：`src/main/services/KnowledgeService.ts`
- UI 展示：`src/renderer/src/components/notebook/SourcePanel.tsx`

#### 最小可行方案

即使没有正文，也允许 document 进入 notebook，但 metadata 里至少有：

- `materialSeedSummary`
- `materialSeedMarkdown`
- `materialSeedQueries`
- `captureStatus`
- `recommendedAction`

### 7.4 P1：补“时间片段和 seek 定位”

#### 为什么要做

`KnowNote` 现在的 chunk 更偏通用文本分块；`知库` 的视频/音频来源会把：

- `start_ms`
- `end_ms`
- `timestamp_label`
- `seek_url`
- `source_kind`
- `quality_level`

落进段级 metadata。

这会直接增强：

- citation 定位
- 回看体验
- 视频类派生资源质量

#### 推荐落点

- `src/main/db/schema.ts`
- `src/main/services/KnowledgeService.ts`
- `src/main/services/FileParserService.ts`
- `src/main/services/loaders/*`
- chat citation 渲染相关组件

#### 设计建议

- 不一定新增独立表，先把 segment metadata 放进 `chunks.metadata`
- 如果后续要支持长音频/视频的精准回跳，再考虑拆 `document_segments`

### 7.5 P1：把问答做成“可解释的反馈回路”

#### 为什么要做

`KnowNote` 已经有聊天，但用户层面的“这轮答案是怎么来的”信息还不够丰富。

`知库` 有两层可以借：

- 检索元信息：query rewrite、focus、route、path
- 质量元信息：当前回答是否 grounded、是否 degraded、是否需要补采集能力

#### 推荐落点

- `src/main/ipc/chatHandlers.ts`
- `src/main/db/queries.ts`
- 可能新增 chat service 或扩展现有 session logic
- `src/renderer/src/store/chatStore.ts`
- `src/renderer/src/components/notebook/chat/*`

#### 迁移重点

不是把 `知库` 的回答模板原样搬过去，而是把这几个能力搬过去：

- query variants
- scoped / global / hierarchical retrieval 标记
- top paths
- focus content
- answer quality feedback
- 对弱材料回答时的 guard rail

### 7.6 P1：补“旧内容升级和修复”

#### 为什么要做

一旦 schema 或 metadata 结构迭代，没有 upgrade/backfill，老数据会长期失真。

`知库` 的 `ContentUpgradeService` 已经给出了成熟样板：

- 扫旧数据
- 判断缺什么
- 优先重抓
- 重抓失败回退本地修复

#### 推荐落点

- 新增服务：`src/main/services/DocumentUpgradeService.ts`
- 新增 IPC：`src/main/ipc/knowledgeHandlers.ts`
- 可选 UI：settings 或 notebook 维护入口

#### 建议功能

- dry run
- 按 notebook / document type 过滤
- limit
- retry incomplete
- force refresh

### 7.7 P2：补“内容术语层”

#### 为什么要做

`知库` 的 `ContentTermService` 很适合用来做：

- 冷启动检索增强
- 自动标签
- seed queries
- question rewrite 辅助

#### 推荐落点

- 新增服务：`src/main/services/DocumentTermService.ts`
- 存储：`documents.metadata.terms`

#### 第一版建议字段

- `primaryTerms`
- `titleTerms`
- `summaryTerms`
- `topicQuery`

### 7.8 P2：从回答沉淀为“带证据的 note item”

#### 为什么要做

`KnowNote` 已经有 `notes` 和 `items`，但如果 chat 到 note 的沉淀不带 citation，用户会失去来源感。

`知库` 的 `save_chat_note` 会把：

- answer
- evidence digest
- citation tags

一起打包成知识卡片。

这套思路适合迁到 `KnowNote`：

- 生成 note
- 附带引用信息到 metadata
- 自动加入 `items`

---

## 8. 推荐的实施顺序

### 阶段 1：只补 metadata，不动主模型

目标：

- 最小代价把 `知库` 的质量逻辑植入 `KnowNote`

动作：

1. 给 `documents.metadata` 补：
   - `captureStatus`
   - `quality`
   - `materialSeed`
   - `terms`
2. 给导入流程补 step/progress 事件
3. 让 renderer 能显示导入状态和质量 badge

### 阶段 2：把 chat 接到质量层

目标：

- 回答时知道什么时候该大胆回答，什么时候该保守

动作：

1. chat 检索结果携带 document quality
2. 弱材料时优先返回解释型 guard rail
3. renderer 展示回答方式、证据数、主命中文档、建议下一步

### 阶段 3：做升级修复

目标：

- 让旧 document 自动吃到新 metadata 结构

动作：

1. 新增 upgrade service
2. 支持 dry-run
3. 支持 retry incomplete capture

### 阶段 4：向派生资源扩散

目标：

- MindMap / Quiz / Anki 使用更高质量的证据底座

动作：

1. 派生生成前判断 source quality
2. 对弱材料给出禁止或提醒
3. 让派生结果保留 chunk/segment mapping

---

## 9. 推荐的并行拆分方式

下面是适合多个 agent 并行的拆法，尽量减少文件冲突。

### Agent A：Schema 与共享类型

职责：

- 增加 `import_jobs/document_jobs`
- 扩展 `documents.metadata` 对应的 shared types
- 处理 migration

推荐写入范围：

- `src/main/db/schema.ts`
- `src/main/db/migrations/*`
- `src/shared/types/knowledge.ts`

不要碰：

- renderer 页面
- chat 逻辑

### Agent B：导入质量层

职责：

- 新增 `InitialMaterialService`
- 新增 `DocumentQualityService`
- 在 `KnowledgeService` 里接入质量计算

推荐写入范围：

- `src/main/services/KnowledgeService.ts`
- `src/main/services/FileParserService.ts`
- `src/main/services/InitialMaterialService.ts`
- `src/main/services/DocumentQualityService.ts`

不要碰：

- renderer chat 组件

### Agent C：知识导入 UI 与进度

职责：

- 把导入 job/progress 展示出来
- 在 renderer 里显示质量 badge、弱材料提示、seed queries

推荐写入范围：

- `src/preload/index.ts`
- `src/main/ipc/knowledgeHandlers.ts`
- `src/renderer/src/store/knowledgeStore.ts`
- `src/renderer/src/components/notebook/SourcePanel.tsx`

不要碰：

- 数据库 schema 迁移文件

### Agent D：问答反馈层

职责：

- 把质量和检索反馈接进 chat
- 给回答增加解释性 metadata 和 guard rail

推荐写入范围：

- `src/main/ipc/chatHandlers.ts`
- 相关 chat service / db query 文件
- `src/renderer/src/store/chatStore.ts`
- `src/renderer/src/components/notebook/chat/*`

不要碰：

- import schema 迁移

### Agent E：旧内容升级

职责：

- 写 document upgrade/backfill
- 提供 dry-run / retry incomplete

推荐写入范围：

- `src/main/services/DocumentUpgradeService.ts`
- `src/main/ipc/knowledgeHandlers.ts`
- 可选设置页入口

注意：

- 这个 agent 最好在 Agent A 的 schema 定稿后开始

---

## 10. 参考文件清单

### 10.1 知库参考文件

优先阅读：

- `services/api/src/zhiku_api/services/import_service.py`
- `services/api/src/zhiku_api/services/initial_material_service.py`
- `services/api/src/zhiku_api/services/note_quality_service.py`
- `services/api/src/zhiku_api/services/content_term_service.py`
- `services/api/src/zhiku_api/services/chat_service.py`
- `services/api/src/zhiku_api/services/content_upgrade_service.py`
- `services/api/src/zhiku_api/repositories/library_repository.py`
- `services/api/src/zhiku_api/routers/imports.py`
- `services/api/src/zhiku_api/routers/contents.py`
- `apps/desktop/src/pages/LibraryPage.tsx`
- `apps/desktop/src/pages/ChatPage.tsx`
- `apps/desktop/src/components/ImportPanel.tsx`

### 10.2 KnowNote 参考文件

优先阅读：

- `src/main/db/schema.ts`
- `src/main/services/KnowledgeService.ts`
- `src/main/services/FileParserService.ts`
- `src/main/services/ChunkingService.ts`
- `src/main/vectorstore/SQLiteVectorStore.ts`
- `src/main/providers/ProviderManager.ts`
- `src/main/ipc/knowledgeHandlers.ts`
- `src/main/ipc/chatHandlers.ts`
- `src/preload/index.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/components/notebook/NotebookLayout.tsx`
- `src/renderer/src/store/knowledgeStore.ts`
- `src/renderer/src/store/chatStore.ts`
- `src/renderer/src/components/notebook/SourcePanel.tsx`

---

## 11. 重要设计约束

后续 agent 改造时，建议始终遵守下面这些约束。

### 11.1 不要把“采集质量”与“检索质量”混为一谈

一个 document 即使已经 indexed，也不等于：

- 来源完整
- 证据可靠
- 可直接生成高质量回答

所以 `indexed` 只能说明“索引完成”，不能代替 `quality.retrievalReady` 或 `quality.questionAnswerReady`。

### 11.2 不要让 LLM 成为导入的硬前置

`知库` 的一个好设计是：

- 没有 LLM，也能完成基础导入
- LLM 主要负责精炼层增强和 query rewrite

`KnowNote` 迁移时应保持这一点。

### 11.3 先放 metadata，再考虑拆表

第一阶段最重要的是把质量逻辑跑通。

因此推荐：

- 先把 `quality / materialSeed / terms / captureStatus` 放在 `documents.metadata`

只有当：

- 查询频率高
- 排序条件复杂
- UI 大量依赖单列过滤

再考虑拆成专门表。

### 11.4 source-specific enrichment 不要污染通用 loader

像下面这些逻辑：

- B 站字幕回退
- 音频转写
- 网页正文补抓
- seek_url 生成

都不应该硬塞进通用 `FileParserService`。

更好的做法是：

- loader 负责抽正文
- enricher 负责补来源特有 metadata

---

## 12. 建议的下一步

如果下一位 agent 要直接开工，建议从下面这个最短路径开始：

1. 在 `KnowNote` 新增 `DocumentQualityService`
2. 在 `KnowledgeService.addDocument*` 里把 quality 和 material seed 写入 `documents.metadata`
3. 在 `knowledgeStore` 和 `SourcePanel` 里展示：
   - 当前质量标签
   - 当前建议动作
   - 是否适合直接问答
4. 再做 `import_jobs`
5. 最后再把 chat feedback 层接进去

这个顺序的好处是：

- 风险低
- 改动边界清晰
- 用户价值最早可见

---

## 13. 最后提醒

这次改造最容易犯的错不是“代码写错”，而是“把两个项目当成同一种产品”。

更准确的理解是：

- `知库` 更强在“来源治理”和“结果可解释”
- `KnowNote` 更强在“Notebook 容器”和“桌面端产品骨架”

正确方向是：

- 用 `知库` 补 `KnowNote` 的质量层
- 用 `KnowNote` 承载 `知库` 的成熟治理逻辑

而不是让一方完全吞掉另一方。
