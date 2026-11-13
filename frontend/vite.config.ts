import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite の設定。
// 本番（Docker）では `npm run build` で静的ファイルを作り、nginx が配信する。
// 開発時（`npm run dev`）は Vite の開発サーバーが画面を配信し、/api だけを FastAPI に中継する。
// これでブラウザから見て同一オリジンになり、本番と同じ "/api/..." の相対パスのまま動く。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        // 既定はホストで直接起動した uvicorn。別の場所の backend を使うときは VITE_API_PROXY で指定する。
        target: process.env.VITE_API_PROXY ?? "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
