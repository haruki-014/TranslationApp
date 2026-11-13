# frontend のコンテナ。2 段階ビルド（マルチステージビルド）にしている。
#   1 段目: Node.js で React をビルドし、静的ファイル（HTML / JS / CSS）を作る
#   2 段目: その静的ファイルだけを nginx のイメージにコピーする
# 実行用のイメージに Node.js や node_modules を含めないので、イメージが小さく、攻撃対象も減る。

# ---- build
FROM node:22-alpine AS build
WORKDIR /app
# backend と同じく、依存関係を先にインストールしてレイヤーのキャッシュを効かせる。
# package-lock.json があれば npm ci で、ロックされたバージョンをそのまま再現する。
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build

# ---- serve（/api は backend にリバースプロキシ。設定は nginx.conf）
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
