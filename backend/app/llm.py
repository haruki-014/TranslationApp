"""モデルサーバー（OpenAI 互換 API）との通信と、翻訳プロンプトの組み立て。

■ なぜ Chat Completions ではなく Completions API を使うのか
PLaMo 3 Translate 同梱のチャットテンプレート（chat_template.jinja）は、
翻訳先を表す `target_lang` などの「テンプレート引数」を必須としている。
LM Studio の Chat Completions API にはこの引数を渡す手段がなく、テンプレートがエラーになる。
そこで、モデルの README が「アプリへの組み込みにはこちらを推奨」としている方法、
つまり PFML3 形式のプロンプトを自前で組み立てて Completions API（/v1/completions）に
そのまま渡す方法を採っている。この方法なら mlx-lm の serve.py でも LM Studio でも同じように動く。

■ PFML3 とは
PLaMo のプロンプト形式。特殊トークンで要素を区切る:
  <|plamo:tag|>要素名  … 要素の始まり（dataset / context / input / output / glossary）
  <|plamo:key|>属性名<|plamo:val|>値 … 要素の属性（lang=ja、form=polite など）
  <|plamo:msg|>本文    … 要素の本文の始まり
最後の output 要素を本文なし（<|plamo:msg|> で終わる形）で置くと、その続きとして訳文が生成され、
モデルは訳文の後に <|plamo:tag|> か <|plamo:bos|> を出して止まる（それを stop に指定する）。

■ PLaMo 以外のモデル
モデル ID に "plamo" を含まないモデル（Qwen など）が選ばれた場合は、PFML3 を理解しないので、
システムプロンプトで翻訳を指示する一般的な Chat Completions にフォールバックする。
"""

import hashlib
import json
import logging
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx

from . import cache
from .config import get_settings

log = logging.getLogger(__name__)

# PLaMo が訳文を出し終えたときに出すトークン。README の推奨どおり両方を stop に指定する。
PLAMO_STOP = ["<|plamo:tag|>", "<|plamo:bos|>"]

# Chat Completions へのフォールバック時に、システムプロンプトへ書く言語名（英語）。
# PFML3 では言語コードをそのまま使うので、この表は汎用モデル向けにだけ使う。
# 表にないコードはコードのまま書く（汎用モデルでも大抵は理解できる）。
LANG_NAMES = {
    "ja": "Japanese",
    "ja(easy)": "easy Japanese (やさしい日本語)",
    "en": "English",
    "zh-hans": "Simplified Chinese",
    "zh-hant": "Traditional Chinese",
    "ko": "Korean",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "ru": "Russian",
    "vi": "Vietnamese",
    "th": "Thai",
    "id": "Indonesian",
    "ar": "Arabic",
    "hi": "Hindi",
}


class LLMError(Exception):
    """モデルサーバーとの通信で起きた、ユーザーに見せてよいエラー。

    メッセージはそのまま画面に表示されるので、日本語で対処方法まで書く。
    """


# ======================================================================== 言語方向


@dataclass
class Direction:
    """1 回の翻訳の言語方向。"""

    source: str | None  # None = 原文の言語を指定しない（モデルに判定させる）
    target: str  # 必ず具体的な言語コード（"auto" はここに来る前に解決済み）


# 日本語を判定するための文字範囲: ひらがな・カタカナ（U+3040–30FF）、
# カタカナ拡張（U+31F0–31FF）、半角カタカナ（U+FF66–FF9F）。
# 漢字は含めない。漢字だけの文は中国語の可能性が高く、日本語扱いすると英語に訳されてしまうため。
_KANA_RE = re.compile(r"[぀-ヿㇰ-ㇿｦ-ﾟ]")


def looks_japanese(text: str) -> bool:
    """かなが 1 文字でも含まれていれば日本語とみなす（簡易判定）。"""
    return bool(_KANA_RE.search(text))


def resolve_direction(text: str, source_lang: str, target_lang: str) -> Direction:
    """チャット設定（"auto" を含む）から、今回の翻訳の具体的な方向を決める。

    翻訳先が "auto" のとき（既定）は「日本語なら英語へ、それ以外なら日本語へ」。
    日本語話者が日英どちらの文も貼り付けられる、いちばんよく使う動作を既定にしている。
    原文の言語が明示されていればそれで判定し、自動なら文字種から判定する。
    """
    src = None if source_lang == "auto" else source_lang
    if target_lang != "auto":
        return Direction(src, target_lang)
    is_ja = src.startswith("ja") if src else looks_japanese(text)
    return Direction(src, "en" if is_ja else "ja")


# ======================================================================== プロンプト


@dataclass
class Pair:
    """対訳履歴の 1 組（過去の原文と、その訳文）。

    言語はペアごとに持つ。チャットの途中で翻訳方向を変えたり、自動判定で日→英と英→日が
    混ざったりしても、PFML3 では要素ごとに lang 属性を付けられるので正しく表現できる。
    """

    source_text: str
    source_lang: str | None
    target_text: str
    target_lang: str


def _safe(text: str) -> str:
    """原文に PFML3 の予約トークン（<|plamo:...|>）が含まれていたら無害化する。

    そのまま入れると、原文の途中で要素が切り替わったと解釈され、プロンプトの構造が壊れる
    （プロンプトインジェクションにもなり得る）。モデル同梱のテンプレートは同じケースを
    エラーにしているが、チャットアプリで弾くと使いにくいので、スペースを挟んで別の文字列にする。
    """
    return text.replace("<|plamo:", "<| plamo:")


def _lang_attr(lang: str | None) -> str:
    """lang 属性。言語が None（自動）なら属性自体を付けない（README の例と同じ）。"""
    return f"<|plamo:key|>lang<|plamo:val|>{lang}" if lang else ""


def build_pfml3(
    text: str,
    direction: Direction,
    history: list[Pair],
    context: str | None,
    form: str | None,
) -> str:
    """PLaMo 3 Translate 用の PFML3 プロンプトを組み立てる。

    要素の並びは README の「対訳履歴をPFML3で指定する」の順序に従う:
      dataset → context（任意）→ [input → output] × 履歴 → input（今回の原文）→ output（空）

    出力例（実際には改行なし）:
      <|plamo:tag|>dataset<|plamo:msg|>translation
      <|plamo:tag|>context<|plamo:msg|>社内向け技術文書
      <|plamo:tag|>input<|plamo:msg|>Open the dashboard.
      <|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>管理画面を開きます。
      <|plamo:tag|>input<|plamo:msg|>It lists all tasks.
      <|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>
    """
    parts: list[str] = []
    if get_settings().plamo_add_bos:
        # 通常はサーバー側のトークナイザが付けるので不要（config.py の plamo_add_bos を参照）
        parts.append("<|plamo:bos|>")
    # このモデルは翻訳専用なので、dataset は必ず translation
    parts.append("<|plamo:tag|>dataset<|plamo:msg|>translation")
    if context and context.strip():
        # 参考文脈は dataset の直後に置く（README の指定）
        parts.append("<|plamo:tag|>context<|plamo:msg|>" + _safe(context))
    for p in history:
        # 過去の対訳。モデルはこれを「すでに訳した前の文」として参照し、用語や文体を揃える。
        parts.append("<|plamo:tag|>input" + _lang_attr(p.source_lang) + "<|plamo:msg|>" + _safe(p.source_text))
        parts.append("<|plamo:tag|>output" + _lang_attr(p.target_lang) + "<|plamo:msg|>" + _safe(p.target_text))
    # 今回の原文
    parts.append("<|plamo:tag|>input" + _lang_attr(direction.source) + "<|plamo:msg|>" + _safe(text))
    # 今回の訳文の器。本文を空にしておき、ここから先をモデルに生成させる。
    output = "<|plamo:tag|>output" + _lang_attr(direction.target)
    if form in ("polite", "plain") and direction.target == "ja":
        # 文体指定は「今回の訳」にだけ付ける。モデルの仕様上、日本語訳のときだけ有効。
        output += f"<|plamo:key|>form<|plamo:val|>{form}"
    parts.append(output + "<|plamo:msg|>")
    return "".join(parts)


def build_chat_messages(
    text: str,
    direction: Direction,
    history: list[Pair],
    context: str | None,
    form: str | None,
) -> list[dict]:
    """PLaMo 以外のモデル向け。PFML3 と同じ情報を、システムプロンプトと会話履歴で表現する。

    - 翻訳先・原文の言語・文体・参考文脈 → システムプロンプト
    - 対訳履歴 → user（原文）/ assistant（訳文）の交互の履歴
    システムプロンプトを英語で書いているのは、多くの汎用モデルで指示の遵守率が高いため。
    """
    target = LANG_NAMES.get(direction.target, direction.target)
    system = (
        f"You are a professional translator. Translate the user's message into {target}. "
        # 汎用モデルは「翻訳結果は以下のとおりです」などの前置きを付けがちなので、訳文だけを出すよう指示する
        "Output only the translation, without explanations, quotes, or notes. "
        "Preserve line breaks, Markdown formatting, and code blocks."
    )
    if direction.source:
        system += f" The source language is {LANG_NAMES.get(direction.source, direction.source)}."
    if form == "polite" and direction.target == "ja":
        system += " Use the polite form (です・ます調)."
    elif form == "plain" and direction.target == "ja":
        system += " Use the plain form (だ・である調)."
    if context and context.strip():
        # 参考文脈まで訳されてしまわないよう、「訳さないこと」と明記する
        system += f"\n\nReference context (do not translate this):\n{context}"
    messages: list[dict] = [{"role": "system", "content": system}]
    for p in history:
        messages.append({"role": "user", "content": p.source_text})
        messages.append({"role": "assistant", "content": p.target_text})
    messages.append({"role": "user", "content": text})
    return messages


def clean_output(text: str) -> str:
    """生成結果に停止トークンが残っていたら、そこから後ろを切り捨てる。

    通常はサーバーが stop を処理するので残らないが、サーバーの実装によっては
    停止トークンそのものが出力に含まれることがある。README も「残っていたら取り除く」よう
    指示している。訳文は対訳履歴として次のプロンプトに入るので、ここで確実に除いておく。
    前後の空白は削らない（原文の空白・改行を保つというモデルの方針に合わせる）。
    """
    for token in PLAMO_STOP + ["<|plamo:eos|>"]:
        idx = text.find(token)
        if idx != -1:
            text = text[:idx]
    return text


def is_plamo(model: str) -> bool:
    """PFML3 で呼ぶべきモデルか。モデル ID に "plamo" を含むかで判定する。

    mlx-server/start.sh は PLAMO_MLX_SERVED_MODEL_NAME で "plamo" を含む名前を名乗らせている
    （serve.py の既定だと ID が "." になり、この判定が効かないため）。
    """
    return "plamo" in model.lower()


# ======================================================================== HTTP


def _base() -> str:
    return get_settings().lmstudio_base_url.rstrip("/")


def _headers() -> dict:
    return {"Authorization": f"Bearer {get_settings().lmstudio_api_key}"}


def _connect_error() -> LLMError:
    # 接続できないときに最も多い原因は「サーバーを起動していない」なので、起動方法まで書く
    return LLMError(
        f"モデルサーバーに接続できません（{_base()}）。mlx-server/start.sh（MLX 版）または LM Studio のローカルサーバーを起動してください。"
    )


async def fetch_models(use_cache: bool = True) -> list[str]:
    """モデルサーバーの /v1/models からモデル ID の一覧を取得する（Redis に短時間キャッシュ）。"""
    if use_cache:
        cached = await cache.get_json(cache.MODELS_KEY)
        if cached is not None:
            return cached
    try:
        # サーバーが止まっているときに画面を長く待たせないよう、タイムアウトは短め（5 秒）
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{_base()}/models", headers=_headers())
            r.raise_for_status()
            data = r.json().get("data", [])
    except httpx.ConnectError as e:
        raise _connect_error() from e
    except httpx.HTTPError as e:
        raise LLMError(f"モデル一覧を取得できませんでした: {e}") from e
    # LM Studio は埋め込みモデルも一覧に含めるが、翻訳には使えないので除外する
    ids = [m["id"] for m in data if "embed" not in m.get("id", "").lower()]
    await cache.set_json(cache.MODELS_KEY, ids, get_settings().models_cache_ttl)
    return ids


def pick_default(models: list[str]) -> str | None:
    """チャットでモデルが指定されていないときに使うモデル。

    優先順位: 設定（DEFAULT_MODEL）> 一覧の中で最初の PLaMo > 一覧の先頭
    """
    configured = get_settings().default_model
    if configured:
        return configured
    for m in models:
        if is_plamo(m):
            return m
    return models[0] if models else None


async def _stream_sse(path: str, payload: dict) -> AsyncIterator[dict]:
    """OpenAI 互換 API に stream=true で POST し、SSE の各チャンク（JSON）を順に返す。

    OpenAI 互換のストリーミング応答は次の形式:
        data: {"choices":[...]}\\n\\n
        data: {"choices":[...]}\\n\\n
        data: [DONE]\\n\\n
    """
    # read=600: 長文の翻訳や、モデルの初回読み込みで最初のトークンまで時間がかかる場合に備えて長めにする
    timeout = httpx.Timeout(connect=10, read=600, write=30, pool=10)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", f"{_base()}{path}", json=payload, headers=_headers()) as r:
                if r.status_code >= 400:
                    # エラー本文に原因が書かれていることが多いので、先頭だけ画面に出す
                    body = (await r.aread()).decode(errors="replace")
                    raise LLMError(f"モデルサーバーがエラーを返しました（{r.status_code}）: {body[:500]}")
                async for line in r.aiter_lines():
                    # SSE のコメント行や空行（イベントの区切り）は読み飛ばす
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data:
                        continue
                    if data == "[DONE]":
                        break
                    obj = json.loads(data)
                    # 生成の途中でエラーになった場合、サーバーによっては {"error": ...} がチャンクとして届く
                    if "error" in obj:
                        err = obj["error"]
                        raise LLMError(err.get("message", str(err)) if isinstance(err, dict) else str(err))
                    yield obj
    except httpx.ConnectError as e:
        raise _connect_error() from e
    except httpx.ReadTimeout as e:
        raise LLMError("モデルサーバーからの応答がタイムアウトしました。") from e


async def stream_translation(
    model: str,
    text: str,
    direction: Direction,
    history: list[Pair],
    context: str | None,
    form: str | None,
) -> AsyncIterator[str]:
    """翻訳を実行し、訳文の断片（差分テキスト）を生成された順に返す。

    呼び出し側（routers/chats.py）はモデルの種類を意識せず、受け取った断片を
    そのままブラウザへ流せばよいように、API の違いをここで吸収している。
    """
    s = get_settings()
    if is_plamo(model):
        # PLaMo: PFML3 プロンプト + Completions API。差分は choices[0].text に入る。
        payload = {
            "model": model,
            "prompt": build_pfml3(text, direction, history, context, form),
            "temperature": s.temperature,
            "max_tokens": s.max_tokens,
            "stop": PLAMO_STOP,
            "stream": True,
        }
        async for obj in _stream_sse("/completions", payload):
            choices = obj.get("choices") or [{}]
            delta = choices[0].get("text") or ""
            if delta:
                yield delta
    else:
        # 汎用モデル: Chat Completions API。差分は choices[0].delta.content に入る。
        # （思考過程を出すモデルの reasoning_content は訳文ではないので無視する）
        payload = {
            "model": model,
            "messages": build_chat_messages(text, direction, history, context, form),
            "temperature": s.temperature,
            "max_tokens": s.max_tokens,
            "stream": True,
        }
        async for obj in _stream_sse("/chat/completions", payload):
            choices = obj.get("choices") or [{}]
            delta = (choices[0].get("delta") or {}).get("content") or ""
            if delta:
                yield delta


def cache_key(model: str, text: str, direction: Direction, history: list[Pair], context: str | None, form: str | None) -> str:
    """翻訳キャッシュのキー。訳文に影響する入力をすべて含めてハッシュ化する。

    原文が同じでも、モデル・言語方向・対訳履歴・参考文脈・文体が違えば訳は変わり得るので、
    それらを全部キーに含める（どれかを含め忘れると、違う条件の訳を返してしまう）。
    sort_keys=True で辞書の順序によってハッシュが変わらないようにしている。
    """
    raw = json.dumps(
        {
            "m": model,
            "t": text,
            "s": direction.source,
            "g": direction.target,
            "h": [p.__dict__ for p in history],
            "c": context,
            "f": form,
            "temp": get_settings().temperature,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return "translation:" + hashlib.sha256(raw.encode()).hexdigest()
