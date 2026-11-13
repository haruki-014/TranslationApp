"""アプリ全体の設定値。

pydantic-settings を使い、環境変数（または .env）から値を読み込む。
フィールド名は大文字・小文字を区別せずに環境変数と対応する
（例: ``lmstudio_base_url`` ← ``LMSTUDIO_BASE_URL``）。

既定値は「Docker を使わずにホストで直接 uvicorn を起動する」ローカル開発を想定している。
Docker Compose で動かすときは docker-compose.yml の environment で上書きされる。
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # extra="ignore": .env に backend と関係ない変数（FRONTEND_PORT など）があってもエラーにしない
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ------------------------------------------------------------ 永続化
    # asyncpg ドライバを使う非同期 SQLAlchemy の接続 URL
    database_url: str = "postgresql+asyncpg://plamo:plamo@localhost:5432/plamo"
    redis_url: str = "redis://localhost:6379/0"

    # ------------------------------------------------------------ モデルサーバー
    # OpenAI 互換 API のベース URL。名前は LM Studio 由来だが、
    # mlx-lm の serve.py（mlx-server/start.sh）など OpenAI 互換なら何でも接続できる。
    lmstudio_base_url: str = "http://localhost:1234/v1"
    # LM Studio / mlx-lm は API キーを検証しないが、OpenAI 互換クライアントの慣習として送る
    lmstudio_api_key: str = "lm-studio"
    # 空ならモデル一覧から "plamo" を含むものを自動で選ぶ（llm.pick_default を参照）
    default_model: str = ""

    # ------------------------------------------------------------ 生成パラメータ
    max_tokens: int = 2048
    # 翻訳は「毎回同じ訳が出る」ほうが扱いやすいので既定は 0（貪欲法）。
    # PLaMo の README の例もすべて temperature=0。0 のときだけ翻訳結果をキャッシュする。
    temperature: float = 0.0
    # 翻訳時にプロンプトへ含める直近の対訳ペア数。
    # 多いほど用語や文体が揃うが、プロンプトが長くなり遅くなる。
    history_pairs: int = 4
    # PFML3 プロンプトの先頭に <|plamo:bos|> を自前で付けるか。
    # mlx-lm のサーバーはトークナイザ設定（add_bos_token=true）で自動付与するため既定は False。
    # 二重に付くと品質が落ちる可能性があるので、自動付与しないサーバーを使うときだけ True にする。
    plamo_add_bos: bool = False

    # ------------------------------------------------------------ キャッシュの有効期限（秒）
    # 同じ原文・同じ条件の翻訳結果。temperature=0 なら結果は決定的なので長めに持つ。
    translation_cache_ttl: int = 60 * 60 * 24
    # モデル一覧。モデルの追加・入れ替えがすぐ反映されるよう短めにする。
    models_cache_ttl: int = 30
    # サイドバーのチャット一覧。更新時に明示的に削除するので TTL は保険。
    chat_list_cache_ttl: int = 60

    # Vite の開発サーバー（5173）から直接 backend を叩く場合のための CORS 許可。
    # 本番構成では nginx が同一オリジンで /api をプロキシするので CORS は不要。
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]


@lru_cache
def get_settings() -> Settings:
    """設定を一度だけ読み込み、以後は同じインスタンスを返す（毎回 .env を読まないため）。"""
    return Settings()
