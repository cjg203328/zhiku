# B站 Cookie 配置说明

推荐优先使用文件方式，而不是把长 Cookie 直接塞进 `.env`。

## 方案 A：直接写入 `.env`

```env
ZHIKU_BILIBILI_COOKIE=SESSDATA=...; bili_jct=...; DedeUserID=...
```

## 方案 B：保存到文件

1. 新建文件：`D:\桌面\zhiku\secrets\bilibili_cookie.txt`
2. 把完整 Cookie 原样粘进去
3. 在 `services/api/.env` 中配置：

```env
ZHIKU_BILIBILI_COOKIE_FILE=D:\桌面\zhiku\secrets\bilibili_cookie.txt
```

## 说明

- 只用于你本人已登录可访问的 B站内容
- 不能绕过平台权限，也不能破解私有/受限内容
- 配置成功后，设置页会显示 `B站登录态：已配置`
- 如果 Cookie 失效，重新从浏览器复制覆盖即可
