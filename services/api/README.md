# Zhiku API

本目录是 `知库` 的本地 sidecar 服务，负责：

- 健康检查
- 配置与系统状态
- 后续的导入、解析、摘要、问答、备份

## 本地开发

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
python -m uvicorn zhiku_api.main:app --app-dir src --reload --host 127.0.0.1 --port 38765
```

## Local ASR

如果你想让无 Cookie 的 B站视频也能尽量恢复正文，可以安装本地 whisper 运行时：

```powershell
python -m pip install -e .[asr-local]
python ..\..\scripts\qa\check_local_asr.py
```

推荐在桌面端设置页把“音频转写”切到“本地转写”，模型先从 `tiny` 或 `small` 开始验证。
