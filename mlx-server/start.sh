#!/usr/bin/env bash
# PLaMo 3 Translate（MLX 版）を mlx-lm の OpenAI 互換サーバーとして起動する。
#
# なぜ LM Studio ではなくこのスクリプトで動かすのか:
#   MLX 版は独自のモデルコード（modeling_plamo_mlx.py）と独自のトークナイザを使う。
#   これを読み込むには trust_remote_code を有効にする必要があるが、LM Studio の MLX エンジンには
#   その設定がなく、読み込みに失敗する。そこでモデル同梱の serve.py（mlx-lm サーバーに
#   PLaMo 用の修正を加えたもの）を使う。モデルファイルは LM Studio でダウンロードしたものをそのまま使う。
#
# Docker の backend からは host.docker.internal:8001 で接続する。
set -euo pipefail  # エラーや未定義変数があれば、その場で止める

HERE="$(cd "$(dirname "$0")" && pwd)"  # このスクリプトがあるディレクトリ（どこから実行しても同じ場所を指す）
MODEL_DIR="${PLAMO_MODEL_DIR:-$HOME/.lmstudio/models/pfnet/plamo-3-translate-2b-MLX-4bit}"
PORT="${PLAMO_PORT:-8001}"  # backend が 8000 を使うので、ぶつからない番号にする
PY="$HERE/.venv/bin/python"  # MLX 用の専用 Python 環境（システムの Python を汚さないため）

if [ ! -x "$PY" ]; then
  echo "Python 環境がありません。次を実行してください:"
  echo "  uv venv $HERE/.venv --python 3.12 && uv pip install --python $PY -r $MODEL_DIR/requirements-mlx.txt"
  exit 1
fi

# /v1/models に返すモデル名。
# serve.py の既定では --model に渡したパス（"."）がそのまま名前になってしまう。
# backend はモデル名に "plamo" が含まれるかで PFML3 形式で呼ぶかを決めるので、分かる名前を付ける。
export PLAMO_MLX_SERVED_MODEL_NAME="${PLAMO_MLX_SERVED_MODEL_NAME:-plamo-3-translate-2b-mlx}"

# serve.py は同じディレクトリのモジュール（server.py など）を import するので、モデルのディレクトリに移動して起動する。
# --trust-remote-code: モデル同梱のコードの実行を許可する（PFN 公式配布のモデルなので許可している）
# --host 127.0.0.1: この Mac の中からだけ接続を受け付ける（LAN の他の端末からは使わせない）。
#   Docker Desktop for Mac では、コンテナから host.docker.internal への接続はホストの 127.0.0.1 に届くので、
#   この設定のままで backend から接続できる。
# exec: シェルをサーバーのプロセスに置き換え、Ctrl+C などのシグナルがサーバーに直接届くようにする
cd "$MODEL_DIR"
exec "$PY" serve.py --model . --trust-remote-code --host 127.0.0.1 --port "$PORT"
