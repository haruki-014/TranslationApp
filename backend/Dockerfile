# backend（FastAPI）のコンテナ。
FROM python:3.12-slim

# PYTHONDONTWRITEBYTECODE: .pyc を書き出さない（コンテナ内では不要なファイルが増えるだけ）
# PYTHONUNBUFFERED: ログを溜めずにすぐ出す（docker compose logs で即座に見えるように）
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# 依存関係を先にインストールし、アプリのコードは後からコピーする。
# Docker はレイヤーごとにキャッシュするので、コードだけを変えたときは pip install をやり直さずに済む。
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 8000
# 0.0.0.0 で待ち受けるのはコンテナ内の話で、外への公開範囲は docker-compose.yml の ports（127.0.0.1）で絞っている
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
