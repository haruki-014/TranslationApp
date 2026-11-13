"""API の入出力スキーマ（Pydantic）。

ORM モデル（models.py）とは分けて定義している。理由:
- 入力では「クライアントが変更してよい項目」だけを受け付け、値の検証もここで行う
- 出力では DB の内部構造をそのまま出さず、画面が必要とする形に揃える
"""

import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# PLaMo 3 Translate が受け付ける言語コードの形式。
# モデル同梱の chat_template.jinja にある check_lang と同じ規則にしている:
#   - 小文字 2〜3 文字の言語コード（ja, en, ceb）
#   - 必要なら「-」と 4 文字の文字体系（zh-hans, zh-hant）
#   - 特別な値 ja(easy)（やさしい日本語）
# 不正なコードをプロンプトに入れると訳がおかしくなるので、保存前に弾く。
_LANG_RE = re.compile(r"^(ja\(easy\)|[a-z]{2,3}(-[a-z]{4})?)$")


def _validate_lang(value: str | None) -> str | None:
    """言語コードの検証。None（PATCH で未指定）と "auto"（自動）はそのまま通す。"""
    if value is None or value == "auto":
        return value
    if not _LANG_RE.match(value):
        raise ValueError("言語コードが不正です（例: ja, en, zh-hans, ja(easy)）")
    return value


class ChatSettings(BaseModel):
    """チャット単位の翻訳設定。作成時の入力に使う。"""

    model: str | None = None
    source_lang: str = "auto"
    target_lang: str = "auto"
    # Literal で「polite / plain / None」以外を受け付けない
    form: Literal["polite", "plain"] | None = None
    # 参考文脈は長すぎるとプロンプトを圧迫するので上限を設ける
    context: str | None = Field(default=None, max_length=4000)
    use_history: bool = True

    # 同じ検証関数を 2 つのフィールドに適用する書き方
    _check_source = field_validator("source_lang")(_validate_lang)
    _check_target = field_validator("target_lang")(_validate_lang)


class ChatCreate(ChatSettings):
    # 省略時は「新しいチャット」。最初のメッセージで原文から自動命名される。
    title: str | None = Field(default=None, max_length=200)


class ChatUpdate(BaseModel):
    """PATCH 用。すべて任意で、送られてきた項目だけを更新する。

    「送られなかった」と「null が送られた」を区別するため、ルーター側で
    model_dump(exclude_unset=True) を使う。model / form / context は null で
    「設定を解除する」意味になるが、title / source_lang / target_lang / use_history は
    null にできない項目なので、null が来ても無視する（routers/chats.py の update_chat）。
    """

    title: str | None = Field(default=None, min_length=1, max_length=200)
    model: str | None = None
    source_lang: str | None = None
    target_lang: str | None = None
    form: Literal["polite", "plain"] | None = None
    context: str | None = Field(default=None, max_length=4000)
    use_history: bool | None = None

    _check_source = field_validator("source_lang")(_validate_lang)
    _check_target = field_validator("target_lang")(_validate_lang)


class MessageOut(BaseModel):
    # from_attributes=True: ORM オブジェクトの属性から直接変換できるようにする
    model_config = ConfigDict(from_attributes=True)

    id: int
    role: str
    content: str
    source_lang: str | None
    target_lang: str | None
    model: str | None
    cached: bool
    stopped: bool
    created_at: datetime


class ChatSummary(BaseModel):
    """一覧用。メッセージ本文は含めない（サイドバーで全件取得するので軽くする）。"""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    model: str | None
    source_lang: str
    target_lang: str
    form: str | None
    context: str | None
    use_history: bool
    created_at: datetime
    updated_at: datetime


class ChatDetail(ChatSummary):
    """個別チャット画面用。メッセージ一覧を含む。"""

    messages: list[MessageOut]


class MessageCreate(BaseModel):
    # 空文字は翻訳できないので 1 文字以上。極端に長い入力はモデルの文脈長を超えるので上限を設ける。
    content: str = Field(min_length=1, max_length=20000)


class BulkDelete(BaseModel):
    # 1 回のリクエストで消せる件数に上限を設け、誤操作や過大なクエリを防ぐ
    ids: list[uuid.UUID] = Field(min_length=1, max_length=500)


class ModelInfo(BaseModel):
    id: str
    # True なら PFML3 プロンプト + Completions API、False なら Chat Completions で呼ぶ
    is_plamo: bool


class ModelsOut(BaseModel):
    models: list[ModelInfo]
    # 自動選択されるモデル（チャットでモデルを指定していないときに使う）
    default: str | None
    # モデルサーバーに接続できたか。False のとき画面上部に警告を出す。
    available: bool
    error: str | None = None
