"""チャット以外の API: モデル一覧とヘルスチェック。"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .. import cache, llm
from ..config import get_settings
from ..database import get_session
from ..schemas import ModelInfo, ModelsOut

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/models", response_model=ModelsOut)
async def list_models(refresh: bool = Query(default=False)):
    """モデルサーバーのモデル一覧。

    接続できないときも HTTP エラーにはせず、available=False とエラー文を返す。
    画面側はそれを見て「未接続」の警告を出すだけで、チャット一覧などはそのまま使えるようにするため。
    refresh=true のときはキャッシュを使わない（画面の「再読み込み」「再接続」ボタン用）。
    """
    try:
        ids = await llm.fetch_models(use_cache=not refresh)
    except llm.LLMError as e:
        return ModelsOut(models=[], default=None, available=False, error=str(e))
    return ModelsOut(
        models=[ModelInfo(id=i, is_plamo=llm.is_plamo(i)) for i in ids],
        default=llm.pick_default(ids),
        available=True,
    )


@router.get("/health")
async def health(session: AsyncSession = Depends(get_session)):
    """依存先（DB / Redis / モデルサーバー）それぞれに接続できるかを返す。

    どれか 1 つが落ちていても 200 を返し、どこが悪いかを中身で示す（切り分けのため）。
    モデルサーバーはキャッシュを使わず、毎回実際に問い合わせる。
    """
    try:
        await session.execute(text("SELECT 1"))
        db_ok = True
    except Exception:  # noqa: BLE001
        db_ok = False
    try:
        await llm.fetch_models(use_cache=False)
        lm_ok = True
    except llm.LLMError:
        lm_ok = False
    return {
        "database": db_ok,
        "redis": await cache.ping(),
        "lmstudio": lm_ok,  # キー名は互換性のため据え置き（実際はモデルサーバー全般）
        "lmstudio_url": get_settings().lmstudio_base_url,
    }
