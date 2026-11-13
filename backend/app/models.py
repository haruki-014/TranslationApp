"""ORM モデル（テーブル定義）。

テーブルは 2 つだけ:
- chats    … 1 つの会話。翻訳設定（言語・文体・参考文脈など）もチャット単位で持つ。
- messages … 会話内の発言。user（原文）と assistant（訳文）が交互に並ぶ。

翻訳設定をチャットに持たせているのは、「このチャットは英→日の技術文書用」のように
用途ごとにチャットを分けて使う想定だから。過去の対訳を参考にする機能（対訳履歴）も、
同じ設定のチャット内で用語を揃える目的で使う。
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    """タイムゾーン付きの現在時刻（UTC）。

    DB の server_default=now() ではなく Python 側で時刻を作っている。
    now() は「トランザクション開始時刻」を返すため、同じトランザクション内で作った行が
    すべて同じ時刻になってしまい、並び順の判定に使えないことがあるから。
    """
    return datetime.now(timezone.utc)


class Chat(Base):
    __tablename__ = "chats"

    # ID は UUID。URL（/chat/<id>）に出るので、連番より推測されにくく、件数も漏れない。
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # 最初のメッセージ送信時に原文の 1 行目から自動で付ける（routers/chats.py の _make_title）
    title: Mapped[str] = mapped_column(String(200), default="新しいチャット")
    # None = サーバーの既定モデルを自動選択。特定モデルに固定したいときだけ値を入れる。
    model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # 言語コードは PLaMo 3 Translate の形式（ja, en, zh-hans, ja(easy) など）。
    # "auto" は特別な値で、source は「モデルに判定させる」、target は「日本語⇄英語を自動判定」。
    source_lang: Mapped[str] = mapped_column(String(16), default="auto")
    target_lang: Mapped[str] = mapped_column(String(16), default="auto")
    # 日本語訳の文体: polite（敬体）/ plain（常体）/ None（指定なし）。
    # PLaMo の PFML3 では output 要素の form 属性に対応し、翻訳先が ja のときだけ有効。
    form: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # 原文を解釈するための参考文脈（場面・読者・前後の文章など）。PFML3 の context 要素になる。
    context: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 過去の対訳（原文と訳文の組）をプロンプトに含めるか
    use_history: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # 最後にメッセージが追加された時刻。サイドバーの並び順（新しい順）と日付グループ分けに使うため索引を張る。
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)

    messages: Mapped[list["Message"]] = relationship(
        back_populates="chat",
        # チャットを ORM 経由で削除したら、メッセージも一緒に削除する
        cascade="all, delete-orphan",
        # 削除は DB の ON DELETE CASCADE に任せ、ORM がメッセージを 1 件ずつ読み込んで消すのを避ける
        passive_deletes=True,
        # id は連番なので、id 順 = 追加された順。時刻より確実に順序を保てる。
        order_by="Message.id",
    )


class Message(Base):
    __tablename__ = "messages"

    # 自動採番の連番。表示順の基準にする（created_at は同時刻になり得るため）。
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    # ondelete="CASCADE": 一括削除（DELETE ... WHERE id IN (...)）のように ORM を通らない削除でも
    # DB 側でメッセージが消えるようにする。chat_id で絞り込むので索引も張る。
    chat_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("chats.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))  # "user"（原文） | "assistant"（訳文）
    content: Mapped[str] = mapped_column(Text)
    # 翻訳した時点の言語方向を、メッセージごとに記録する。
    # チャットの設定は後から変えられるので、過去の対訳を履歴として使うときは
    # 「その訳がどの方向で作られたか」をメッセージから読む必要がある。
    #   user.source_lang      … 送信時に明示されていた原文の言語（自動なら None）
    #   assistant.source_lang … 同上（表示用）
    #   assistant.target_lang … 実際に訳した先の言語（auto を解決した後の値）
    source_lang: Mapped[str | None] = mapped_column(String(16), nullable=True)
    target_lang: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # 訳文を生成したモデル（画面に小さく表示する）
    model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Redis の翻訳キャッシュから返した訳文か（画面に「キャッシュ」と表示する）
    cached: Mapped[bool] = mapped_column(Boolean, default=False)
    # ユーザーが途中で停止した訳文か。途中までの訳は対訳履歴に使わない（不完全な訳を参考にさせないため）。
    stopped: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    chat: Mapped[Chat] = relationship(back_populates="messages")
