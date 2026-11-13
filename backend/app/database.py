"""データベース接続（SQLAlchemy 2.x の非同期 API）。

FastAPI は非同期で動くため、DB アクセスも asyncpg + AsyncSession で行い、
問い合わせ待ちの間にほかのリクエスト（翻訳のストリーミングなど）を処理できるようにしている。
"""

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import get_settings

# pool_pre_ping=True: プールから接続を取り出すたびに生存確認する。
# DB コンテナの再起動などで切れた接続を使ってエラーになるのを防ぐ。
engine = create_async_engine(get_settings().database_url, pool_pre_ping=True)

# expire_on_commit=False: commit 後もオブジェクトの属性を読めるようにする。
# 既定（True）だと commit 後に属性へアクセスした時点で再読み込みが走り、
# 非同期 SQLAlchemy ではそれがエラー（MissingGreenlet）になるため。
# 例えば「保存したメッセージを commit してから JSON にしてクライアントへ返す」処理で必要。
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    """全 ORM モデルの基底クラス。Base.metadata.create_all でテーブルを作る（main.py）。"""


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI の依存性注入（Depends）用。リクエストごとにセッションを開き、終わったら閉じる。

    注意: ストリーミングレスポンスの本体（ジェネレータ）は、エンドポイント関数が return した
    「後」に実行される。依存性で開いたセッションがその時点で閉じている可能性があるため、
    ストリーミング中の DB 操作は SessionLocal() で独自にセッションを開く（routers/chats.py）。
    """
    async with SessionLocal() as session:
        yield session
