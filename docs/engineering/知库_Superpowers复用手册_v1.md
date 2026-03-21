# 知库 Superpowers 复用手册（v1）

## 1. 文档目的

本文档用于提炼 `obra/superpowers` 中适合 `知库` 的工程方法，并明确哪些内容从现在开始直接采用，哪些内容只保留思路、不机械照搬。

---

## 2. 这次吸收的核心方法

## 2.1 先设计，后实现

`superpowers` 最有价值的一点，是在写代码前先把目标、边界、验证方式说清楚。

这和 `知库` 当前阶段高度匹配，因为我们不是在堆 demo，而是在做：

- 内容采集
- 知识整理
- RAG 问答
- 产品化体验

这些任务一旦边界不清，很容易反复返工。

因此，从现在开始，`知库` 的非小修任务默认都要先明确：

- 任务目标
- 本次不做
- 主链路
- 影响文件
- 验证方式
- 风险与回退

## 2.2 计划必须足够细，才能稳定执行

`superpowers` 强调：计划不是写给“已经懂项目的人”，而是写给“几乎没有上下文也能执行的人”。

这点对 `知库` 很重要。

后续计划默认要求：

- 步骤足够小
- 文件路径明确
- 验证命令明确
- 不写模糊动作，例如“补一下逻辑”

## 2.3 调试必须先找根因，不能猜

`superpowers` 的 `systematic-debugging` 很值得保留。

后续 `知库` 遇到以下问题时，默认按“根因优先”处理：

- 链接解析失败
- 模型调用异常
- 构建失败
- 页面交互异常
- 问答结果异常

固定顺序：

1. 先稳定复现
2. 再读错误与链路日志
3. 再定位断点在哪一层
4. 再形成单一假设
5. 再做最小修复
6. 再重新验证

禁止一上来连改几处碰运气。

## 2.4 没验证，就不能说完成

`verification-before-completion` 这条规则对我们非常重要。

从现在开始，`知库` 的完成声明必须建立在当轮新鲜验证上。

至少要满足：

- 改后端：跑后端编译或相关验证
- 改前端：跑前端构建或相关验证
- 改主链路：跑直接相关路径

没有验证输出，就不能说“已经好了”。

## 2.5 复杂实现要拆成小闭环

`superpowers` 的一个关键思想是：复杂任务不要一口气做完，而要拆成可验证的小闭环。

在 `知库` 中，默认拆法是：

- 采集层闭环
- 整理层闭环
- 检索层闭环
- 问答层闭环
- 产品体验闭环

每一轮只推进 1 到 2 个最关键闭环。

---

## 3. 在知库中的直接落地

## 3.1 适合直接采用的

- 设计先于实现
- 细颗粒度计划
- 系统化调试
- 验证先于完成宣称
- 分闭环推进

## 3.2 不机械照搬的

以下内容保留思路，但不作为当前硬规则：

- `git worktree` 驱动的并行开发
- 强依赖子代理的执行流程
- 每一步都要求独立提交

原因不是这些方法不好，而是 `知库` 当前阶段更需要：

- 快速稳定迭代
- 保持上下文连续
- 先把主链路做深做稳

---

## 4. 对当前知库最有帮助的 4 条新约束

从现在开始，后续开发新增以下约束：

### 约束 1：导入失败先排查链路，不直接改文案兜底

如果是：

- B站解析失败
- 网页正文抽取失败
- ASR 失败

先定位失败层级：

- URL 识别
- 平台页面抓取
- 字幕抓取
- 音频转写
- 整理入库

### 约束 2：问答效果差，先看证据链，不先怪模型

后续问答异常排查顺序固定为：

1. 是否命中资料
2. 命中内容是否足够
3. 切块是否合理
4. 引用是否真实支撑结论
5. 最后才看模型能力

### 约束 3：每次产品改动都要带状态设计

页面类任务必须说明：

- 默认状态
- 加载状态
- 空状态
- 异常状态
- 成功状态

不能只做“成功时能展示”的页面。

### 约束 4：每轮交付必须给出可验证结果

每轮同步至少要包含：

- 改了什么
- 哪些文件变了
- 跑了什么验证
- 还有什么风险
- 下一步是什么

---

## 5. 对知库当前路线的补强价值

结合 `BiliNote`、`ragent`、`claude-skills`、`superpowers` 四条线，`知库` 当前的方法论可以定为：

- `BiliNote` 提供内容采集与整理方向
- `ragent` 提供问答策略与检索增强方向
- `claude-skills` 提供 Common Ground 与专家路由
- `superpowers` 提供设计、计划、调试、验证纪律

这四者结合后，`知库` 后续开发会更稳，不容易继续出现：

- 功能看起来多，但主链路不稳
- 页面像产品，但逻辑像原型
- 问答像聊天，但证据链不够

---

## 6. 后续默认执行模板

后续每次进入中等以上任务，默认按下面模板推进：

### 开始前

- 目标
- 不做
- 主链路
- 影响文件
- 验证方式

### 实现中

- 优先主路径
- 一次只改一个关键假设
- 遇到 bug 先排根因

### 完成前

- 跑验证命令
- 读输出
- 确认真实状态
- 再同步结果

---

## 7. 关联文档

- `docs/engineering/知库_全栈工程技能基线_v1.md`
- `docs/engineering/知库_COMMON_GROUND.md`
- `docs/engineering/知库_ClaudeSkills复用手册_v1.md`
- `docs/product/知库_MVP与开发规范_v2.md`
- `docs/product/知库_开发进度同步.md`

---

## 8. 参考来源

- `https://github.com/obra/superpowers`
- `https://raw.githubusercontent.com/obra/superpowers/main/README.md`
- `https://raw.githubusercontent.com/obra/superpowers/main/docs/README.codex.md`
- `https://raw.githubusercontent.com/obra/superpowers/main/skills/brainstorming/SKILL.md`
- `https://raw.githubusercontent.com/obra/superpowers/main/skills/writing-plans/SKILL.md`
- `https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md`
- `https://raw.githubusercontent.com/obra/superpowers/main/skills/verification-before-completion/SKILL.md`
