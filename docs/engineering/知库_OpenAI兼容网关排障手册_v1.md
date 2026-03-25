# 知库 OpenAI 兼容网关排障手册（v1）

## 1. 文档目的

本文档用于沉淀一次已经在 `知库` 项目内真实复现、真实修复过的网关兼容问题，方便后续继续接入第三方 OpenAI 兼容平台时直接复用。

这不是一次性的对话备忘，而是一份可以重复执行的排障手册。

---

## 2. 适用场景

当你在 `知库` 的模型设置页中接入自定义 OpenAI 兼容网关，并出现以下任一现象时，应优先参考本文档：

- `GET /v1/models` 能通，但“检查连接”失败
- 设置页里看起来像是 `API Key` 无权限，但你怀疑并不是鉴权问题
- 同一个网关在别的客户端里能用，在 `知库` 里却失败
- 网关返回 `text/event-stream`
- 网关要求 `stream=true`
- Python 后端访问失败，但浏览器、`.NET` 或其他客户端访问正常

---

## 3. 这次真实案例的现象

本轮真实案例的目标网关是一个 OpenAI 兼容入口，表现如下：

- `GET /v1/models` 返回 `200`，模型目录可读
- 返回模型列表中确实存在目标模型，例如 `gpt-5.4`
- `POST /v1/chat/completions` 在常规 JSON 请求下返回 `400`
- 错误信息明确提示：`Stream must be set to true`
- 同样的聊天请求在 Python `urllib` 下可能进一步被 Cloudflare 拦截，返回 `403` 和 `error code: 1010`
- 换成更接近浏览器的请求头后，流式请求可以成功返回 `text/event-stream`

这说明“模型目录可读”并不等于“聊天接口一定兼容当前客户端实现”。

---

## 4. 根因拆解

这次问题最终不是单点故障，而是两层兼容问题叠加：

### 4.1 第一层：聊天接口要求流式返回

目标网关虽然兼容 OpenAI 的 `chat/completions` 路径，但不接受普通非流式请求。

具体表现：

- 请求体未带 `stream=true`
- 接口返回 `400`
- 返回信息包含 `Stream must be set to true`

这类平台本质上是“协议兼容不完整”或“实现上强制要求流式”。

### 4.2 第二层：Python 默认请求头被风控拦截

在 Python `urllib` 下，即使请求体已经改为 `stream=true`，仍可能因为默认请求头过于“脚本化”而被网关前置风控拦截。

具体表现：

- `HTTP 403`
- 返回 `error code: 1010`
- 同一个地址换成浏览器风格 `User-Agent` 后可恢复

这类问题本质上不是业务鉴权失败，而是边缘网关或 Cloudflare/WAF 的客户端识别策略导致的访问差异。

---

## 5. 标准排障流程

后续如果再遇到类似问题，默认按以下顺序排查，不要一上来就判断是 `API Key` 错误。

### 5.1 先确认基础路径是否正确

优先确认网关根地址到底是不是：

- `https://host/v1`
- 还是 `https://host`
- 还是更深一级的自定义 path

如果用户只提供域名根地址，优先尝试 `/v1`。

### 5.2 先测模型目录，不要先测聊天

优先发送：

```http
GET /v1/models
Authorization: Bearer <REDACTED_API_KEY>
```

判断标准：

- 如果返回 `200` 且有模型列表，说明基本网关和 `Key` 大概率可用
- 如果返回的是 HTML 页面，说明大概率打到了官网，不是 API 根地址
- 如果返回 `401/403`，再去怀疑 `Key`、权限或账户问题

### 5.3 再测常规聊天请求

发送标准非流式请求：

```json
{
  "model": "your-model",
  "messages": [
    {
      "role": "user",
      "content": "只回复连接成功"
    }
  ]
}
```

如果这一步返回：

- `400` 且提示 `Stream must be set to true`

则说明下一步应切到流式模式验证，而不是继续怀疑模型名或 `Key`。

### 5.4 再测流式聊天请求

发送：

```json
{
  "model": "your-model",
  "messages": [
    {
      "role": "user",
      "content": "只回复连接成功"
    }
  ],
  "stream": true
}
```

如果返回：

- `200`
- `Content-Type: text/event-stream`
- 响应体含有 `data: {...}` 和最后的 `data: [DONE]`

则说明该网关要求流式请求，客户端必须兼容 SSE 分片解析。

### 5.5 对比不同客户端行为

如果 `.NET`、浏览器或 `curl` 能通，但 Python 后端不通，不要急着改业务参数，先比对：

- `User-Agent`
- `Accept`
- 是否走了流式
- 是否命中 Cloudflare / WAF

如果 Python 返回 `403 + error code: 1010`，高度怀疑是客户端头部或风控问题。

---

## 6. 知库中的最终处理策略

这次在 `知库` 中采用了四个层次的处理方案。

### 6.1 设置页优先降低误填概率

在设置页中，对自定义 provider 做如下兜底：

- 用户只填 `API Host` 时，优先按 `/v1` 推断
- 用户把完整地址直接粘贴进 `API Host` 时，自动拆分出 Host 和 Path
- 端点预览显示真实生效地址，而不是只显示表单原值

这样可以先规避“把官网根域名误当 API 根地址”的问题。

### 6.2 后端默认先走普通 JSON 请求

`知库` 后端不会默认把所有请求都改成流式，而是先按普通 JSON 请求发送。

好处：

- 不影响原本已经兼容标准非流式 OpenAI 网关的平台
- 不会为了一个特殊网关把所有路径都复杂化

### 6.3 当网关明确要求流式时自动回退

如果聊天请求返回：

- `400`
- 且错误文本中包含 `Stream must be set to true`

则自动回退到：

```json
{
  "stream": true
}
```

并重新请求同一个 `chat/completions` 端点。

### 6.4 为高风控网关补浏览器风格请求头

为了兼容会拦截 Python 默认客户端的网关，模型目录请求与聊天请求都补了更接近浏览器的请求头，例如：

- `User-Agent: Mozilla/5.0 ... Chrome/... Safari/... Zhiku/0.1`
- `Accept: application/json`
- `Accept: application/json, text/event-stream`

这不是为了伪装，而是为了降低“明显脚本头”被风控直接拒绝的概率。

### 6.5 对 SSE 流式响应做最小解析

对于 `text/event-stream` 响应，后端只做最小必要解析：

- 逐行读取 `data: ...`
- 跳过空行
- 跳过 `data: [DONE]`
- 解析 `choices[].delta.content`
- 把分片文本拼回普通字符串

这样上层业务仍然可以像处理普通聊天返回一样使用文本结果。

---

## 7. 推荐验证命令

以下命令建议保留为后续排障模板。示例中的 `API Key` 一律使用脱敏占位符。

### 7.1 验证模型目录

```powershell
$headers = @{ Authorization = "Bearer <REDACTED_API_KEY>" }
Invoke-WebRequest -Uri "https://your-host.example.com/v1/models" -Headers $headers -Method GET
```

### 7.2 验证非流式聊天

```powershell
Add-Type -AssemblyName System.Net.Http
$client = New-Object System.Net.Http.HttpClient
$client.DefaultRequestHeaders.Authorization =
  New-Object System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", "<REDACTED_API_KEY>")
$body = '{"model":"your-model","messages":[{"role":"user","content":"只回复连接成功"}]}'
$content = New-Object System.Net.Http.StringContent($body, [System.Text.Encoding]::UTF8, "application/json")
$response = $client.PostAsync("https://your-host.example.com/v1/chat/completions", $content).GetAwaiter().GetResult()
$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
```

### 7.3 验证流式聊天

```powershell
Add-Type -AssemblyName System.Net.Http
$client = New-Object System.Net.Http.HttpClient
$client.DefaultRequestHeaders.Authorization =
  New-Object System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", "<REDACTED_API_KEY>")
$body = '{"model":"your-model","messages":[{"role":"user","content":"只回复连接成功"}],"stream":true}'
$content = New-Object System.Net.Http.StringContent($body, [System.Text.Encoding]::UTF8, "application/json")
$response = $client.PostAsync("https://your-host.example.com/v1/chat/completions", $content).GetAwaiter().GetResult()
$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
```

---

## 8. 合规与安全要求

这部分必须长期遵守。

### 8.1 不要把真实 API Key 写入仓库

以下位置都不允许写入真实密钥：

- 代码文件
- Markdown 文档
- 变更日志
- 示例脚本
- 截图说明

文档中统一使用：

- `<REDACTED_API_KEY>`
- `<YOUR_API_KEY>`

### 8.2 一旦在对话或截图中暴露过密钥，默认视为泄露风险

如果真实 `API Key` 已经出现在：

- 对话记录
- 截图
- 命令历史
- 临时文件

建议动作：

1. 立即轮换该密钥
2. 删除本地明文缓存
3. 后续验证改用新密钥

### 8.3 文档只记录“现象和方法”，不记录敏感业务值

可以记录：

- 域名结构
- 路径形式
- 错误码
- 调试结论

不要记录：

- 真实密钥
- 用户私有组织 ID
- 账户额度信息
- 带个人身份信息的请求体

---

## 9. 后续复用时的判断口诀

后续遇到“模型列表可读，但检查连接失败”的情况，优先按这组判断：

1. 先看是不是少了 `/v1`
2. 再看 `GET /models` 是否返回 JSON
3. 再看聊天接口是否要求 `stream=true`
4. 再看 Python 客户端是不是被风控拦截
5. 最后才怀疑 `API Key`、模型权限或账户额度

这能显著减少误诊。

---

## 10. 当前已在知库中落地的对应实现

本轮经验已经在 `知库` 项目中形成实际代码实现，关键位置如下：

- `services/api/src/zhiku_api/services/llm_gateway.py`
- `apps/desktop/src/pages/SettingsPage.tsx`

其中已经落地的能力包括：

- 自定义 provider 的 `/v1` 默认兜底
- 完整地址自动拆分 Host / Path
- `stream=true` 自动回退
- SSE 文本拼接
- 浏览器风格请求头兼容

---

## 11. 当前边界

本文档覆盖的是“OpenAI 兼容 `chat/completions` 网关”的兼容问题。

当前尚未覆盖的情况包括：

- 只支持 `responses` API 的平台
- 需要额外 query 参数的 Azure 风格平台
- 需要自定义 header 的企业网关
- 需要多阶段签名的专有平台

这些情况需要在后续文档中继续补充，不要误以为本文档覆盖了全部网关差异。

---

## 12. 本文档结论

这次案例最重要的经验不是“某个特定域名怎么配”，而是：

- 先验证路径
- 先验证模型目录
- 再验证聊天协议
- 区分业务鉴权失败和客户端被风控拦截
- 能抽象成通用兼容层的，优先沉淀到代码和文档中

后续只要继续按这套方法排查，类似问题基本都能更快定位。
