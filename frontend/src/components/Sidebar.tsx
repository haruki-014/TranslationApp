// 左側のサイドバー（Claude のサイドバーに相当）。
//
// 上から:
//   開閉ボタン + アプリ名
//   「新しいチャット」「チャット（一覧ページ）」へのリンク
//   最近のチャット（今日 / 昨日 / 過去7日間 … でまとめる）。各行の「…」から名前の変更・削除
//   下端: モデルサーバーへの接続状態
//
// 表示モードは 3 種類:
//   - デスクトップで展開（幅 288px）
//   - デスクトップで折りたたみ（幅 56px、アイコンだけ）
//   - モバイル（幅 768px 以下）: 普段は隠れていて、メニューボタンで画面の上に重なって開く（ドロワー）

import { useMemo, useState } from "react";
import { NavLink, useMatch, useNavigate } from "react-router-dom";
import { useApp } from "../store";
import { dateGroup, type Group } from "../time";
import type { ChatSummary } from "../types";
import { ConfirmDialog } from "./ConfirmDialog";
import { ChatIcon, DotsIcon, LogoMark, PencilIcon, PlusIcon, SidebarIcon, TrashIcon } from "./Icons";
import { Popover } from "./Popover";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

// 見出しを表示する順番
const GROUP_ORDER: Group[] = ["今日", "昨日", "過去7日間", "過去30日間", "それ以前"];

export function Sidebar({ collapsed: collapsedProp, onToggle, mobileOpen, onCloseMobile }: Props) {
  // モバイルでドロワーとして開いている間は、デスクトップで折りたたんでいても常に展開表示にする
  // （折りたたみ表示のままだとチャット一覧が見えず、ドロワーを開く意味がないため）
  const collapsed = collapsedProp && !mobileOpen;
  const { chats, models, removeChats, renameChat } = useApp();
  const navigate = useNavigate();
  // いま開いているチャットを強調表示するため、URL から ID を取り出す
  const match = useMatch("/chat/:id");
  const activeId = match?.params.id;
  const [deleting, setDeleting] = useState<ChatSummary | null>(null); // 削除確認中のチャット
  const [renamingId, setRenamingId] = useState<string | null>(null); // 名前を編集中のチャット

  // チャットを日付グループごとにまとめる。chats は新しい順に並んでいるので、各グループ内も新しい順になる。
  // チャット一覧が変わったときだけ計算し直す（useMemo）。
  const groups = useMemo(() => {
    const map = new Map<Group, ChatSummary[]>();
    for (const c of chats) {
      const g = dateGroup(c.updated_at);
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g)! }));
  }, [chats]);

  const confirmDelete = async () => {
    if (!deleting) return;
    const id = deleting.id;
    setDeleting(null);
    await removeChats([id]);
    // 開いているチャットを消したら、存在しない画面に残らないようホームへ戻る
    if (id === activeId) navigate("/");
  };

  return (
    <>
      {/* モバイルでドロワーを開いているときの暗い背景。タップで閉じる。 */}
      {mobileOpen && <div className="sidebar-backdrop" onClick={onCloseMobile} />}
      <aside className={`sidebar ${collapsed ? "collapsed" : ""} ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-top">
          <button className="icon-btn" onClick={onToggle} title={collapsed ? "サイドバーを開く" : "サイドバーを閉じる"}>
            <SidebarIcon />
          </button>
          {!collapsed && (
            <NavLink to="/" className="brand" onClick={onCloseMobile}>
              PLaMo Translate
            </NavLink>
          )}
        </div>

        <nav className="sidebar-nav">
          {/* end: "/" と完全一致したときだけ active にする（"/chat/..." でも active にならないように） */}
          <NavLink to="/" end className="nav-item new-chat" onClick={onCloseMobile} title="新しいチャット">
            <span className="new-chat-icon">
              <PlusIcon size={14} />
            </span>
            {!collapsed && <span>新しいチャット</span>}
          </NavLink>
          <NavLink to="/recents" className="nav-item" onClick={onCloseMobile} title="チャット">
            <ChatIcon size={17} />
            {!collapsed && <span>チャット</span>}
          </NavLink>
        </nav>

        {/* 折りたたみ時はタイトルを表示できる幅がないので、一覧ごと隠す */}
        {!collapsed && (
          <div className="sidebar-list">
            {groups.length === 0 && <div className="sidebar-empty">まだチャットはありません</div>}
            {groups.map(({ group, items }) => (
              <section key={group}>
                <div className="sidebar-section-title">{group}</div>
                {items.map((c) =>
                  renamingId === c.id ? (
                    // 名前の変更は、その行をその場で入力欄に切り替えて行う（ダイアログを出さない）
                    <RenameInput
                      key={c.id}
                      initial={c.title}
                      onDone={async (title) => {
                        setRenamingId(null);
                        if (title && title !== c.title) await renameChat(c.id, title);
                      }}
                    />
                  ) : (
                    <div key={c.id} className={`chat-item ${c.id === activeId ? "active" : ""}`}>
                      <NavLink to={`/chat/${c.id}`} className="chat-item-link" onClick={onCloseMobile} title={c.title}>
                        {c.title}
                      </NavLink>
                      {/* 「…」メニュー。行にマウスを乗せたときだけ表示する（styles.css の .chat-item-menu） */}
                      <Popover
                        align="right"
                        placement="bottom"
                        trigger={(open, toggle) => (
                          <button
                            className={`icon-btn small chat-item-menu ${open ? "open" : ""}`}
                            onClick={toggle}
                            title="メニュー"
                          >
                            <DotsIcon size={16} />
                          </button>
                        )}
                      >
                        {(close) => (
                          <div className="menu compact">
                            <button
                              className="menu-item"
                              onClick={() => {
                                close();
                                setRenamingId(c.id);
                              }}
                            >
                              <PencilIcon size={15} />
                              <span>名前を変更</span>
                            </button>
                            <button
                              className="menu-item danger"
                              onClick={() => {
                                close();
                                setDeleting(c);
                              }}
                            >
                              <TrashIcon size={15} />
                              <span>削除</span>
                            </button>
                          </div>
                        )}
                      </Popover>
                    </div>
                  ),
                )}
              </section>
            ))}
          </div>
        )}

        {/* モデルサーバーの接続状態。つながらないときに原因（エラー文）をツールチップで見られる。 */}
        <div className="sidebar-footer" title={models?.error ?? ""}>
          <LogoMark size={26} />
          {!collapsed && (
            <div className="footer-text">
              <div className="footer-title">モデルサーバー</div>
              <div className="footer-status">
                {/* 緑 = 接続中、赤 = 未接続、灰 = 確認中 */}
                <span className={`status-dot ${models?.available ? "ok" : models ? "ng" : ""}`} />
                {models == null ? "確認中…" : models.available ? `${models.models.length} モデル利用可能` : "未接続"}
              </div>
            </div>
          )}
        </div>
      </aside>

      <ConfirmDialog
        open={deleting !== null}
        title="チャットを削除"
        message={`「${deleting?.title ?? ""}」を削除しますか？この操作は取り消せません。`}
        confirmLabel="削除"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

/**
 * サイドバーの行の中で、チャット名をその場で編集する入力欄。
 * Enter かフォーカスを外すと確定、Esc で取り消し。空にした場合は変更しない（null を返す）。
 */
function RenameInput({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="chat-item renaming">
      <input
        className="rename-input"
        autoFocus
        value={value}
        maxLength={200}
        onChange={(e) => setValue(e.target.value)}
        // 開いた時点で全選択しておき、すぐに新しい名前を打ち込めるようにする
        onFocus={(e) => e.target.select()}
        onBlur={() => onDone(value.trim() || null)}
        onKeyDown={(e) => {
          // 日本語入力の変換確定の Enter では確定しない
          if (e.key === "Enter" && !e.nativeEvent.isComposing) onDone(value.trim() || null);
          if (e.key === "Escape") onDone(null);
        }}
      />
    </div>
  );
}
