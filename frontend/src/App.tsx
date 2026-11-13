// 画面全体のレイアウト（左にサイドバー、右にメイン領域）とルーティング。
//
// URL とページの対応:
//   /           … 新しいチャット（あいさつと入力欄）
//   /recents    … チャット一覧（検索・まとめて削除）
//   /chat/:id   … 個別チャット
//   それ以外    … 新しいチャットを表示する

import { useEffect, useState } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { MenuIcon, RefreshIcon } from "./components/Icons";
import { Sidebar } from "./components/Sidebar";
import ChatList from "./pages/ChatList";
import ChatView from "./pages/ChatView";
import NewChat from "./pages/NewChat";
import { useApp } from "./store";

// サイドバーの開閉状態は、次に開いたときも同じ状態になるよう localStorage に覚えておく
const COLLAPSE_KEY = "plamo:sidebar-collapsed";

export default function App() {
  const [collapsed, setCollapsed] = useState(() => {
    // localStorage はプライベートブラウズなどで例外を投げることがあるので try で囲む
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  // モバイル（狭い画面）でサイドバーをドロワーとして開いているか
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { models, refreshModels } = useApp();

  // ページを移動したらドロワーを閉じる（チャットを選んだのに一覧が被さったまま、とならないように）
  useEffect(() => setMobileOpen(false), [location.pathname]);

  // サイドバーの開閉ボタン。画面幅によって意味が変わる:
  //   狭い画面: ドロワーの開閉（折りたたみ状態は変えない）
  //   広い画面: 展開 ⇄ 折りたたみ（状態を保存する）
  const toggle = () => {
    if (window.matchMedia("(max-width: 768px)").matches) {
      setMobileOpen((o) => !o);
      return;
    }
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  return (
    <div className="app">
      <Sidebar collapsed={collapsed} onToggle={toggle} mobileOpen={mobileOpen} onCloseMobile={() => setMobileOpen(false)} />
      <main className="main">
        {/* モバイル用のメニューボタン（広い画面では CSS で非表示） */}
        <button className="icon-btn mobile-menu" onClick={() => setMobileOpen(true)} title="メニュー">
          <MenuIcon />
        </button>
        {/* モデルサーバーにつながらないときは、どのページでも上部に警告を出す。
            チャット一覧の閲覧・削除はできるので、画面全体をエラーにはしない。 */}
        {models && !models.available && (
          <div className="banner warn top">
            <span>{models.error ?? "モデルサーバーに接続できません。"}</span>
            <button className="btn btn-ghost small" onClick={() => refreshModels(true)}>
              <RefreshIcon size={14} />
              再接続
            </button>
          </div>
        )}
        <Routes>
          <Route path="/" element={<NewChat />} />
          <Route path="/recents" element={<ChatList />} />
          <Route path="/chat/:id" element={<ChatView />} />
          <Route path="*" element={<NewChat />} />
        </Routes>
      </main>
    </div>
  );
}
