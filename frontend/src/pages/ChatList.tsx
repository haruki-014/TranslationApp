// チャット一覧ページ（"/recents"）。Claude の「チャット」ページに相当する。
//
// サイドバーより広い表示で、次のことができる:
//   - タイトルと本文の検索
//   - 「選択」モードでチェックを付けて、まとめて削除
//   - 1 件ずつの削除（行にマウスを乗せるとゴミ箱ボタンが出る）

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PlusIcon, SearchIcon, TrashIcon, XIcon } from "../components/Icons";
import { langLabel, targetLabel } from "../languages";
import { useApp } from "../store";
import { relativeTime } from "../time";
import type { ChatSummary } from "../types";

export default function ChatList() {
  const navigate = useNavigate();
  const { chats, chatsLoaded, removeChats } = useApp();
  const [query, setQuery] = useState("");
  // 検索結果。null = 検索していない（共有のチャット一覧をそのまま表示する）
  const [results, setResults] = useState<ChatSummary[] | null>(null);
  const [selecting, setSelecting] = useState(false); // 選択モードか
  const [selected, setSelected] = useState<Set<string>>(new Set()); // 選択中のチャット ID
  // 削除確認中のチャット ID（1 件の削除も、まとめて削除も同じダイアログで確認する）
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  // 検索。本文も対象にするためサーバーで検索する。
  // 1 文字打つごとに API を呼ばないよう、入力が 250ms 止まってから呼ぶ（デバウンス）。
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      api.listChats(q).then(setResults).catch(() => setResults([]));
    }, 250);
    // 次の入力が来たら、前回の予約を取り消す
    return () => clearTimeout(t);
  }, [query]);

  // 表示する一覧。検索結果は取得した時点のものなので、その後で削除したチャットは
  // 共有の一覧（chats）と突き合わせて除外し、消したのに残って見えることがないようにする。
  const list = useMemo(() => {
    if (!results) return chats;
    const alive = new Set(chats.map((c) => c.id));
    return results.filter((c) => alive.has(c.id));
  }, [results, chats]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      // Set は中身を変えても React が変化に気付かないので、必ず新しい Set を作って返す
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = list.length > 0 && list.every((c) => selected.has(c.id));

  const exitSelect = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const confirm = async () => {
    if (!pendingDelete) return;
    const ids = pendingDelete;
    setPendingDelete(null);
    await removeChats(ids);
    // 消したチャットを選択状態から外す
    setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
    // まとめて削除した後は、選択モードを抜けて通常の一覧に戻す
    if (selecting && ids.length > 1) exitSelect();
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <h1 className="page-title">チャット</h1>
          <button className="btn btn-primary" onClick={() => navigate("/")}>
            <PlusIcon size={16} />
            新しいチャット
          </button>
        </div>

        <div className="search-box">
          <SearchIcon size={18} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="チャットを検索…"
            autoFocus
          />
          {query && (
            <button className="icon-btn small" onClick={() => setQuery("")} title="クリア">
              <XIcon size={15} />
            </button>
          )}
        </div>

        {/* 一覧の上のツールバー。通常時は件数と「選択」、選択モードでは全選択と削除ボタン */}
        <div className="list-toolbar">
          {selecting ? (
            <>
              <label className="select-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  // 全部選ばれていれば全解除、そうでなければ表示中の全件を選択（検索中なら検索結果だけ）
                  onChange={() => setSelected(allSelected ? new Set() : new Set(list.map((c) => c.id)))}
                />
                {selected.size} 件選択中
              </label>
              <div className="toolbar-actions">
                <button
                  className="btn btn-danger small"
                  disabled={selected.size === 0}
                  onClick={() => setPendingDelete([...selected])}
                >
                  <TrashIcon size={15} />
                  削除
                </button>
                <button className="btn btn-ghost small" onClick={exitSelect}>
                  キャンセル
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="muted">
                {results ? `「${query}」の検索結果: ${list.length} 件` : `${chats.length} 件のチャット`}
              </span>
              {list.length > 0 && (
                <button className="link-btn" onClick={() => setSelecting(true)}>
                  選択
                </button>
              )}
            </>
          )}
        </div>

        <ul className="chat-list">
          {/* 読み込み中に「まだチャットはありません」がちらつかないよう、読み込み後にだけ出す */}
          {chatsLoaded && list.length === 0 && (
            <li className="chat-list-empty">{results ? "見つかりませんでした" : "まだチャットはありません"}</li>
          )}
          {list.map((c) => (
            <li key={c.id} className={`chat-row ${selected.has(c.id) ? "selected" : ""}`}>
              {selecting && (
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
              )}
              <Link
                to={`/chat/${c.id}`}
                className="chat-row-link"
                onClick={(e) => {
                  // 選択モード中は、行のどこを押してもチャットを開かずに選択を切り替える（チェックボックスが小さいため）
                  if (selecting) {
                    e.preventDefault();
                    toggle(c.id);
                  }
                }}
              >
                <span className="chat-row-title">{c.title}</span>
                <span className="chat-row-meta">
                  {c.source_lang === "auto" && c.target_lang === "auto"
                    ? "自動（日⇄英）"
                    : `${langLabel(c.source_lang)} → ${targetLabel(c.target_lang)}`}
                  {" · "}最終更新 {relativeTime(c.updated_at)}
                </span>
              </Link>
              {!selecting && (
                <button className="icon-btn small row-delete" title="削除" onClick={() => setPendingDelete([c.id])}>
                  <TrashIcon size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete && pendingDelete.length > 1 ? `${pendingDelete.length} 件のチャットを削除` : "チャットを削除"}
        message="選択したチャットを削除しますか？この操作は取り消せません。"
        confirmLabel="削除"
        danger
        onConfirm={confirm}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
