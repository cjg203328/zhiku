# 架构说明

当前工程采用：

- `apps/desktop`：前端桌面壳
- `services/api`：本地 sidecar 服务
- 前后端通过 `HTTP + SSE` 通信
- 数据最终写入本地知识库目录
