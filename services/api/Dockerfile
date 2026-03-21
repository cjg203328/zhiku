FROM python:3.11-slim

WORKDIR /app

# 安装系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖配置并安装
COPY pyproject.toml ./
COPY src/ ./src/

RUN pip install --no-cache-dir -e .

# 数据目录由外部挂载
VOLUME ["/data"]

ENV ZHIKU_KNOWLEDGE_BASE_DIR=/data

EXPOSE 38765

CMD ["uvicorn", "zhiku_api.main:app", "--host", "0.0.0.0", "--port", "38765"]
