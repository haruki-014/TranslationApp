"""Redis キャッシュ。

Redis に置いているもの:
- chats:list         … サイドバーのチャット一覧（画面遷移のたびに取得されるため）
- lmstudio:models    … モデルサーバーのモデル一覧（毎回問い合わせると遅く、サーバー停止時に待たされるため）
- translation:<hash> … 翻訳結果（同じ原文・同じ条件なら、モデルを呼ばずに即座に返すため）

方針: キャッシュはあくまで高速化のためのもの。Redis が落ちていても
アプリ自体は動くよう、すべての操作で例外を握りつぶし、警告ログだけを出す。
（Redis 障害で翻訳までできなくなるのは本末転倒なので）
"""

import json
import logging
from typing import Any

import redis.asyncio as redis

from .config import get_settings

log = logging.getLogger(__name__)

# decode_responses=True: bytes ではなく str で値を受け取る（JSON や訳文をそのまま扱えるように）。
# from_url は接続プールを作るだけで、この時点では接続しない（Redis が後から起動しても問題ない）。
client: redis.Redis = redis.from_url(get_settings().redis_url, decode_responses=True)

CHAT_LIST_KEY = "chats:list"
MODELS_KEY = "lmstudio:models"


async def get_json(key: str) -> Any | None:
    """JSON を読み込む。キーがない／Redis に接続できないときは None（＝キャッシュミス扱い）。"""
    try:
        raw = await client.get(key)
        return json.loads(raw) if raw else None
    except Exception as e:  # noqa: BLE001  （Redis の例外は種類が多いので、まとめて受ける）
        log.warning("redis get failed: %s", e)
        return None


async def set_json(key: str, value: Any, ttl: int) -> None:
    """JSON として保存する。default=str は datetime や UUID を文字列にするため。"""
    try:
        await client.set(key, json.dumps(value, default=str, ensure_ascii=False), ex=ttl)
    except Exception as e:  # noqa: BLE001
        log.warning("redis set failed: %s", e)


async def get_str(key: str) -> str | None:
    """文字列（訳文）をそのまま読む。"""
    try:
        return await client.get(key)
    except Exception as e:  # noqa: BLE001
        log.warning("redis get failed: %s", e)
        return None


async def set_str(key: str, value: str, ttl: int) -> None:
    try:
        await client.set(key, value, ex=ttl)
    except Exception as e:  # noqa: BLE001
        log.warning("redis set failed: %s", e)


async def delete(*keys: str) -> None:
    try:
        await client.delete(*keys)
    except Exception as e:  # noqa: BLE001
        log.warning("redis delete failed: %s", e)


async def invalidate_chat_list() -> None:
    """チャットの作成・更新・削除・メッセージ追加のたびに呼び、一覧キャッシュを捨てる。

    差分を書き換えるより「捨てて次回取り直す」ほうが単純で、整合性の崩れが起きにくい。
    """
    await delete(CHAT_LIST_KEY)


async def ping() -> bool:
    """ヘルスチェック用。"""
    try:
        return bool(await client.ping())
    except Exception:  # noqa: BLE001
        return False
