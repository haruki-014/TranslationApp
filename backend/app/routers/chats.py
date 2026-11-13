"""チャットの CRUD と、翻訳のストリーミング API。

エンドポイント:
  GET    /api/chats                  一覧（?q= でタイトルと本文を検索）
  POST   /api/chats                  作成
  GET    /api/chats/{id}             詳細（メッセージ付き）
  PATCH  /api/chats/{id}             タイトル・翻訳設定の変更
  DELETE /api/chats/{id}             削除
  POST   /api/chats/bulk-delete      複数削除
  POST   /api/chats/{id}/messages    原文を送って翻訳（SSE）
  POST   /api/chats/{id}/regenerate  最後の訳をやり直す（SSE）
"""

import asyncio
import json
import logging
import uuid
from collections.abc import AsyncIterator

import anyio
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .. import cache, llm
from ..config import get_settings
from ..database import SessionLocal, get_session
from ..models import Chat, Message, utcnow
from ..schemas import (
    BulkDelete,
    ChatCreate,
    ChatDetail,
    ChatSummary,
    ChatUpdate,
    MessageCreate,
    MessageOut,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/chats", tags=["chats"])

# 切断時の保存処理を逃がしたバックグラウンドタスクへの参照。
# asyncio はタスクを弱参照でしか持たないので、参照を保持しないと完了前に GC で消えることがある。
_background: set[asyncio.Task] = set()


# ======================================================================== CRUD


@router.get("", response_model=list[ChatSummary])
async def list_chats(
    q: str | None = Query(default=None, max_length=200),
    session: AsyncSession = Depends(get_session),
):
    """チャット一覧（更新が新しい順）。

    検索なしの一覧はサイドバーが画面遷移のたびに取得するので Redis にキャッシュする。
    検索結果は語句ごとに変わり、再利用されにくいのでキャッシュしない。
    """
    if not q:
        cached = await cache.get_json(cache.CHAT_LIST_KEY)
        if cached is not None:
            return cached

    stmt = select(Chat).order_by(Chat.updated_at.desc())
    if q:
        # タイトルか、いずれかのメッセージ本文に語句を含むチャット（大文字・小文字を区別しない）。
        # 件数が少ない個人用アプリ想定なので、全文検索インデックスは使わず ILIKE で十分としている。
        like = f"%{q}%"
        sub = select(Message.chat_id).where(Message.content.ilike(like))
        stmt = stmt.where(Chat.title.ilike(like) | Chat.id.in_(sub))
    chats = (await session.scalars(stmt)).all()
    # キャッシュに入れられるよう、JSON にできる形（UUID・日時は文字列）へ変換しておく
    result = [ChatSummary.model_validate(c).model_dump(mode="json") for c in chats]
    if not q:
        await cache.set_json(cache.CHAT_LIST_KEY, result, get_settings().chat_list_cache_ttl)
    return result


@router.post("", response_model=ChatSummary, status_code=201)
async def create_chat(body: ChatCreate, session: AsyncSession = Depends(get_session)):
    """空のチャットを作る。

    画面では「最初のメッセージを送った瞬間」に作成 → その画面へ移動 → 送信、の順で呼ばれる
    （frontend の NewChat.tsx）。翻訳設定はホーム画面で選んだものがそのまま渡される。
    """
    data = body.model_dump()
    title = data.pop("title") or "新しいチャット"
    chat = Chat(title=title, **data)
    session.add(chat)
    await session.commit()
    await cache.invalidate_chat_list()
    return chat


async def _get_chat(session: AsyncSession, chat_id: uuid.UUID, with_messages: bool = False) -> Chat:
    """チャットを取得する。なければ 404。

    with_messages=True のときは selectinload でメッセージを同時に読み込む。
    非同期 SQLAlchemy では、後から chat.messages に触れて遅延読み込みさせることができない
    （MissingGreenlet エラーになる）ため、必要なときは最初に明示的に読み込む。
    """
    stmt = select(Chat).where(Chat.id == chat_id)
    if with_messages:
        stmt = stmt.options(selectinload(Chat.messages))
    chat = await session.scalar(stmt)
    if chat is None:
        raise HTTPException(404, "チャットが見つかりません")
    return chat


@router.get("/{chat_id}", response_model=ChatDetail)
async def get_chat(chat_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    return await _get_chat(session, chat_id, with_messages=True)


@router.patch("/{chat_id}", response_model=ChatSummary)
async def update_chat(chat_id: uuid.UUID, body: ChatUpdate, session: AsyncSession = Depends(get_session)):
    """送られてきた項目だけを更新する（exclude_unset=True）。

    model / form / context は null で「解除」できる。
    title などの必須項目は null を許さないので、null が来ても無視する。
    """
    chat = await _get_chat(session, chat_id)
    for key, value in body.model_dump(exclude_unset=True).items():
        if key in ("title", "source_lang", "target_lang", "use_history") and value is None:
            continue
        setattr(chat, key, value)
    await session.commit()
    await cache.invalidate_chat_list()
    return chat


@router.delete("/{chat_id}", status_code=204)
async def delete_chat(chat_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    """チャットを削除する。メッセージは外部キーの ON DELETE CASCADE で一緒に消える。"""
    chat = await _get_chat(session, chat_id)
    await session.delete(chat)
    await session.commit()
    await cache.invalidate_chat_list()
    return Response(status_code=204)


@router.post("/bulk-delete")
async def bulk_delete(body: BulkDelete, session: AsyncSession = Depends(get_session)):
    """複数のチャットを 1 回の DELETE 文で削除する（チャット一覧画面の「選択して削除」用）。

    ORM オブジェクトを 1 件ずつ読み込まずに済むよう、DELETE ... WHERE id IN (...) を直接発行する。
    存在しない ID が混ざっていてもエラーにはせず、実際に消えた件数を返す。
    """
    result = await session.execute(delete(Chat).where(Chat.id.in_(body.ids)))
    await session.commit()
    await cache.invalidate_chat_list()
    return {"deleted": result.rowcount}


# ======================================================================== 翻訳（SSE ストリーミング）
#
# 訳文を 1 文字ずつでも早く見せるため、Server-Sent Events（SSE）で逐次送る。
# ブラウザ標準の EventSource は GET しか送れないので、フロントエンドは fetch で POST し、
# レスポンス本文を自前で読み取っている（frontend/src/api.ts の streamEvents）。
#
# 送るイベント（すべて "data: <JSON>\n\n" 形式）:
#   {"type": "user",  "message": {...}, "title": "..."}  保存したユーザーメッセージ（仮 ID を本物に置き換える用）
#   {"type": "start", "model": "...", "source_lang": ..., "target_lang": "..."}  使うモデルと言語方向
#   {"type": "delta", "content": "..."}  訳文の断片（何度も届く）
#   {"type": "done",  "message": {...}}  保存した訳文メッセージ
#   {"type": "error", "error": "..."}    エラー（画面に表示する文言）
#
# エラーを HTTP ステータスではなくイベントで返しているのは、ストリームの途中で起きたエラーは
# ヘッダー送信後なのでステータスを変えられないため。開始前のエラーも同じ形に揃えている。


def _sse(event: dict) -> str:
    """1 イベント分の SSE テキストを作る。ensure_ascii=False で日本語をそのまま送る。"""
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"


def _history_pairs(messages: list[Message], limit: int) -> list[llm.Pair]:
    """メッセージ列から、対訳履歴として使える (原文, 訳文) の組を取り出す。直近 limit 組だけ返す。

    user の直後に assistant が来ている組だけを採用する。次の訳文は除外する:
    - 空の訳文（エラーで何も生成されなかった）
    - 途中で停止した訳文（不完全な訳を手本にさせると品質が落ちる）
    - target_lang が記録されていない訳文（言語属性を付けられない）
    """
    pairs: list[llm.Pair] = []
    i = 0
    while i < len(messages) - 1:
        u, a = messages[i], messages[i + 1]
        if u.role == "user" and a.role == "assistant":
            if a.content.strip() and not a.stopped and a.target_lang:
                pairs.append(llm.Pair(u.content, u.source_lang, a.content, a.target_lang))
            i += 2
        else:
            # 訳文のないユーザーメッセージ（翻訳失敗など）は読み飛ばし、組がずれないようにする
            i += 1
    return pairs[-limit:] if limit > 0 else []


def _make_title(text: str) -> str:
    """原文の 1 行目を 40 文字までに切ってチャットのタイトルにする（Claude のような自動命名）。"""
    first = text.strip().splitlines()[0] if text.strip() else "新しいチャット"
    return first[:40] + ("…" if len(first) > 40 else "")


async def _translate_stream(chat_id: uuid.UUID, text: str | None) -> AsyncIterator[str]:
    """翻訳の本体。SSE のテキストを順に yield する非同期ジェネレータ。

    text が None のときは「再翻訳」: 最後の訳文を消し、最後の原文をもう一度訳す。

    DB セッションは処理の段階ごとに SessionLocal() で開き直している。
    - ストリーミング本体はエンドポイント関数が return した後に動くので、Depends のセッションは使えない
    - 生成中（数秒〜数十秒）に DB 接続を握り続けないようにするため
    """
    settings = get_settings()

    # ---------------------------------------------------- 1. 原文を保存し、翻訳に必要な情報を集める
    async with SessionLocal() as session:
        chat = await session.scalar(select(Chat).where(Chat.id == chat_id).options(selectinload(Chat.messages)))
        if chat is None:
            yield _sse({"type": "error", "error": "チャットが見つかりません"})
            return
        messages = list(chat.messages)

        if text is None:
            # 再翻訳: 末尾が訳文ならそれを削除し、その前の原文を訳し直す
            if messages and messages[-1].role == "assistant":
                await session.delete(messages.pop())
            if not messages or messages[-1].role != "user":
                yield _sse({"type": "error", "error": "再翻訳するメッセージがありません"})
                return
            user_msg = messages[-1]
            prior = messages[:-1]
        else:
            # 新しい原文。送信時点で原文の言語が明示されていれば記録しておく（対訳履歴の lang 属性に使う）
            source = None if chat.source_lang == "auto" else chat.source_lang
            user_msg = Message(chat_id=chat.id, role="user", content=text, source_lang=source)
            session.add(user_msg)
            prior = messages
            # 最初のメッセージで、未命名のチャットに自動でタイトルを付ける（手動で付けた名前は上書きしない）
            if not messages and chat.title == "新しいチャット":
                chat.title = _make_title(text)

        # サイドバーで一番上に来るよう更新時刻を進める
        chat.updated_at = utcnow()
        # 訳を生成する前に原文を確定させておく。生成中に失敗・切断しても原文は残る。
        await session.commit()
        await cache.invalidate_chat_list()

        # この後はセッションを閉じるので、必要な値をローカル変数に取り出しておく
        source_text = user_msg.content
        direction = llm.resolve_direction(source_text, chat.source_lang, chat.target_lang)
        history = _history_pairs(prior, settings.history_pairs) if chat.use_history else []
        context, form, chat_model = chat.context, chat.form, chat.model
        yield _sse(
            {
                "type": "user",
                "message": MessageOut.model_validate(user_msg).model_dump(mode="json"),
                "title": chat.title,
            }
        )

    # ---------------------------------------------------- 2. 使うモデルを決める
    # チャットで固定されていればそれ、なければサーバーの既定（PLaMo を優先）
    model = chat_model
    if not model:
        try:
            model = llm.pick_default(await llm.fetch_models())
        except llm.LLMError as e:
            yield _sse({"type": "error", "error": str(e)})
            return
    if not model:
        yield _sse({"type": "error", "error": "利用可能なモデルがありません。モデルサーバーでモデルを読み込んでください。"})
        return

    # 画面は訳文が届く前に「→ 英語」などの言語ラベルを出せる
    yield _sse({"type": "start", "model": model, "source_lang": direction.source, "target_lang": direction.target})

    # ---------------------------------------------------- 3. 翻訳（Redis キャッシュ → モデルサーバー）
    # temperature が 0 なら同じ入力に同じ訳が返るので、結果をキャッシュして使い回せる。
    # 0 より大きいと毎回違う訳が出るのが意図なので、キャッシュしない。
    use_cache = settings.temperature == 0
    key = llm.cache_key(model, source_text, direction, history, context, form)
    collected = ""  # これまでに受け取った訳文（停止時の途中保存にも使う）
    from_cache = False

    async def save(content: str, stopped: bool) -> Message:
        """訳文を保存する。新しいセッションを開くので、どの段階からでも呼べる。"""
        async with SessionLocal() as s:
            msg = Message(
                chat_id=chat_id,
                role="assistant",
                content=content,
                source_lang=direction.source,
                target_lang=direction.target,
                model=model,
                cached=from_cache,
                stopped=stopped,
            )
            s.add(msg)
            c = await s.get(Chat, chat_id)
            if c is not None:  # 翻訳中にチャットが削除された場合は None
                c.updated_at = utcnow()
            await s.commit()
            await cache.invalidate_chat_list()
            return msg

    try:
        # 再翻訳（text is None）のときはキャッシュを読まない。
        # 「やり直したい」のに同じ結果を即座に返すと、操作が効いていないように見えるため。
        hit = await cache.get_str(key) if (use_cache and text is not None) else None
        if hit is not None:
            from_cache = True
            collected = hit
            yield _sse({"type": "delta", "content": hit})  # キャッシュは一度にまとめて送る
        else:
            async for delta in llm.stream_translation(model, source_text, direction, history, context, form):
                collected += delta
                yield _sse({"type": "delta", "content": delta})
            collected = llm.clean_output(collected)
            if use_cache and collected.strip():
                await cache.set_str(key, collected, settings.translation_cache_ttl)

        msg = await save(collected, stopped=False)
        # 画面はこのメッセージで仮表示を置き換える（停止トークン除去後の最終的な訳文になる）
        yield _sse({"type": "done", "message": MessageOut.model_validate(msg).model_dump(mode="json")})
    except llm.LLMError as e:
        # 接続できない・サーバーエラーなど。原文は保存済みなので、画面から「再翻訳」できる。
        yield _sse({"type": "error", "error": str(e)})
    except anyio.get_cancelled_exc_class():
        # ユーザーが「停止」ボタンを押した（＝ブラウザが接続を切った）場合。
        # Starlette は切断を検知するとこのジェネレータをキャンセルする。
        # キャンセル後の await はふつう即座に再キャンセルされるので、shield=True のスコープで
        # キャンセルから守ったうえで、途中までの訳文を「停止した訳」として保存する。
        with anyio.CancelScope(shield=True):
            if collected.strip():
                await save(llm.clean_output(collected), stopped=True)
        raise  # キャンセルは握りつぶさずに伝える（握りつぶすとタスクが正しく終わらない）
    except GeneratorExit:
        # yield で一時停止している最中に切断された場合は、キャンセルではなく GeneratorExit が届く。
        # この状況では await できないので、保存処理を別タスクに逃がす。
        if collected.strip():
            task = asyncio.get_running_loop().create_task(save(llm.clean_output(collected), stopped=True))
            _background.add(task)
            task.add_done_callback(_background.discard)
        raise
    except Exception as e:  # noqa: BLE001
        # 想定外のエラーもストリームを壊さず、エラーイベントとして画面に伝える
        log.exception("translation failed")
        yield _sse({"type": "error", "error": f"翻訳中にエラーが発生しました: {e}"})


# SSE 用のレスポンスヘッダー:
#   Cache-Control: no-cache … 途中経過がブラウザやプロキシにキャッシュされないように
#   X-Accel-Buffering: no   … nginx にバッファリングさせない（nginx.conf でも proxy_buffering off にしている）
_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


@router.post("/{chat_id}/messages")
async def send_message(chat_id: uuid.UUID, body: MessageCreate, session: AsyncSession = Depends(get_session)):
    # ストリームを始める前に存在確認だけしておく。ない場合は SSE ではなく通常の 404 を返せる。
    await _get_chat(session, chat_id)
    return StreamingResponse(
        _translate_stream(chat_id, body.content), media_type="text/event-stream", headers=_SSE_HEADERS
    )


@router.post("/{chat_id}/regenerate")
async def regenerate(chat_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    await _get_chat(session, chat_id)
    return StreamingResponse(_translate_stream(chat_id, None), media_type="text/event-stream", headers=_SSE_HEADERS)
