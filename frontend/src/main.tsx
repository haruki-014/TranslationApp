// フロントエンドのエントリーポイント。
//
// 構成:
//   BrowserRouter … URL とページの対応（/ = 新しいチャット、/recents = 一覧、/chat/:id = 個別チャット）
//   AppProvider   … チャット一覧・モデル一覧の共有状態（store.tsx）
//   App           … サイドバー + メイン領域のレイアウトとルーティング（App.tsx）

import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AppProvider } from "./store";
import "./styles.css";

// React.StrictMode は使っていない。
// StrictMode は開発時に useEffect を「実行 → 後片付け → 再実行」と 2 回動かすため、
// 翻訳ストリームの開始やチャットの読み込みが二重に走り、本番と挙動が変わってしまう。
// ストリーミングのように副作用の大きい処理を扱うアプリなので、開発時と本番の挙動を揃えるほうを優先した。
createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <AppProvider>
      <App />
    </AppProvider>
  </BrowserRouter>,
);
