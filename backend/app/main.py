"""FastAPI アプリのエントリーポイント（uvicorn app.main:app で起動）。"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .database import Base, engine
from .routers import chats, system

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


async def _init_db(retries: int = 20) -> None:
    """テーブルがなければ作る。DB の起動を待つため、失敗したら 2 秒おきに再試行する。

    docker-compose では healthcheck で DB の起動を待ってから backend を起動しているが、
    compose 以外で起動した場合や、DB の再起動直後にも備えて再試行を入れている。

    マイグレーションツール（Alembic）は使っていない。create_all は「ないテーブルを作る」だけで、
    既存テーブルの列追加・変更はしない。スキーマを変えるときは Alembic の導入が必要。
    """
    for attempt in range(1, retries + 1):
        try:
            async with engine.begin() as conn:
                # create_all は同期 API なので run_sync 経由で呼ぶ
                await conn.run_sync(Base.metadata.create_all)
            return
        except Exception as e:  # noqa: BLE001
            log.warning("DB not ready (%d/%d): %s", attempt, retries, e)
            await asyncio.sleep(2)
    raise RuntimeError("データベースに接続できませんでした")


@asynccontextmanager
async def lifespan(_: FastAPI):
    """起動時と終了時の処理。yield より前が起動時、後が終了時。"""
    await _init_db()
    yield
    # 終了時に接続プールを閉じる（コンテナ停止時に DB 側へ接続が残らないように）
    await engine.dispose()


app = FastAPI(title="PLaMo Translate Chat", lifespan=lifespan)

# CORS は Vite の開発サーバー（別オリジン）から直接 API を叩く場合のためのもの。
# Docker 構成では nginx が同じオリジンで /api を中継するので、ブラウザから見て CORS は発生しない。
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(chats.router)   # /api/chats/...（チャットの CRUD と翻訳）
app.include_router(system.router)  # /api/models, /api/health
