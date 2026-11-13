# PLaMo Translate Chat

LM Studio で動かす **PLaMo 3 Translate** を使った翻訳チャットアプリです。
UI は Claude のチャット画面を参考にしています。

- **Backend**: FastAPI（SSE ストリーミング）
- **DB**: PostgreSQL（チャット・メッセージ）
- **Cache**: Redis（チャット一覧、LM Studio のモデル一覧、翻訳結果）
- **Frontend**: React + Vite（nginx で配信し、`/api` を backend にプロキシ）
- **LLM**: ホストの Mac で動く LM Studio の OpenAI 互換 API

## 機能

- 新しいチャット / チャット一覧（検索・複数選択して削除）/ 個別チャット
- サイドバーでチャット履歴を日付ごとに表示（名前の変更・削除）
- 翻訳結果のストリーミング表示、停止、再翻訳、コピー
- 翻訳方向（自動で日⇄英、または 53 言語から指定）、日本語の文体（敬体・常体）、参考文脈、対訳履歴
- モデル切り替え（LM Studio にロード済みのモデルから選択）
- ライト／ダークモード、モバイル表示

## 起動（MLX 版 PLaMo 3 を使う構成）

LM Studio でダウンロードした `pfnet/plamo-3-translate-2b-MLX-4bit` を、モデル同梱の `serve.py`（mlx-lm の OpenAI 互換サーバー）で動かします。
Docker の backend は、ホストの `host.docker.internal:8001` でこのサーバーに接続します。

```bash
# 1. 初回のみ: MLX サーバー用の Python 環境を作る
uv venv mlx-server/.venv --python 3.12
uv pip install --python mlx-server/.venv/bin/python -r ~/.lmstudio/models/pfnet/plamo-3-translate-2b-MLX-4bit/requirements-mlx.txt
```

```bash
# 2. MLX サーバーを起動（ホスト側で起動したままにする。ポートは 8001）
./mlx-server/start.sh
```

```bash
# 3. 初回のみ: 接続先を設定する（.env の LMSTUDIO_BASE_URL を http://host.docker.internal:8001/v1 にする）
cp .env.example .env
```

```bash
# 4. アプリを起動
docker compose up -d --build
```

ブラウザで http://localhost:3000 を開きます。動作状態は http://localhost:3000/api/health で確認できます。

### なぜ LM Studio の中で動かさないのか

MLX 版は独自のモデルコード（`modeling_plamo_mlx.py`）を必要とします。
しかし、LM Studio の MLX エンジンでは `trust_remote_code` を有効にできないため、次のエラーで読み込みに失敗します。

```
Model config requests a custom module ('modeling_plamo_mlx.py') ... Pass trust_remote_code=True
```

モデルファイルは LM Studio でダウンロードしたものをそのまま使い、推論だけを `serve.py` で行います。

### LM Studio で動くモデルを使う場合

GGUF 版の PLaMo や Qwen など、LM Studio で読み込めるモデルも使えます。
LM Studio の **Developer** タブでローカルサーバーを起動し（`lms server start`）、`.env` を `LMSTUDIO_BASE_URL=http://host.docker.internal:1234/v1` に変えてから `docker compose up -d backend` を実行してください。

## PLaMo の呼び出し方

PLaMo 3 Translate のチャットテンプレートは `target_lang` などの引数が必須です。
LM Studio の Chat Completions API からはこの引数を渡せません。
そこで backend では、モデルの README が推奨する **PFML3 形式のプロンプト**を組み立て、**Completions API**（`/v1/completions`）に送っています（[backend/app/llm.py](backend/app/llm.py)）。

```
<|plamo:tag|>dataset<|plamo:msg|>translation
<|plamo:tag|>context<|plamo:msg|>（参考文脈）
<|plamo:tag|>input<|plamo:msg|>（過去の原文）<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:msg|>（過去の訳文）
<|plamo:tag|>input<|plamo:msg|>（今回の原文）<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>polite<|plamo:msg|>
```

※ 実際のプロンプトには改行を入れません。stop には `<|plamo:tag|>` と `<|plamo:bos|>` を指定しています。

- モデル ID に `plamo` を含むモデルでは、上の PFML3 プロンプトを使います。
- それ以外のモデル（Qwen など）では、システムプロンプト付きの Chat Completions にフォールバックします。
- LM Studio が文頭トークンを自動で付けない場合は、`.env` で `PLAMO_ADD_BOS=true` にしてください。

## 設定（.env）

| 変数 | 既定値 | 説明 |
|---|---|---|
| `LMSTUDIO_BASE_URL` | `http://host.docker.internal:1234/v1` | LM Studio の API |
| `DEFAULT_MODEL` | （空） | 空なら `plamo` を含むモデルを自動で選択 |
| `MAX_TOKENS` | `2048` | 生成するトークン数の上限 |
| `TEMPERATURE` | `0` | 0 のとき、同じ条件の翻訳を Redis にキャッシュ |
| `HISTORY_PAIRS` | `4` | プロンプトに含める直近の対訳ペア数 |
| `PLAMO_ADD_BOS` | `false` | PFML3 の先頭に `<|plamo:bos|>` を付ける |

## API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/chats?q=` | チャット一覧（`q` でタイトルと本文を検索） |
| POST | `/api/chats` | チャット作成 |
| GET | `/api/chats/{id}` | チャット詳細（メッセージ付き） |
| PATCH | `/api/chats/{id}` | タイトルや翻訳設定の変更 |
| DELETE | `/api/chats/{id}` | チャット削除 |
| POST | `/api/chats/bulk-delete` | 複数のチャットを削除 |
| POST | `/api/chats/{id}/messages` | 翻訳（SSE） |
| POST | `/api/chats/{id}/regenerate` | 最後の翻訳をやり直す（SSE） |
| GET | `/api/models` | LM Studio のモデル一覧 |
| GET | `/api/health` | DB、Redis、LM Studio の接続状態 |

## ローカル開発（Docker を使わない場合）

```bash
docker compose up -d db redis
cd backend && pip install -r requirements.txt
DATABASE_URL=postgresql+asyncpg://plamo:plamo@localhost:5432/plamo uvicorn app.main:app --reload
```

この場合は、`docker-compose.yml` の db と redis に `ports`（`5432:5432` と `6379:6379`）を追加してください。

```bash
cd frontend && npm install && npm run dev   # http://localhost:5173
```
