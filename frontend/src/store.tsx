// アプリ全体で共有する状態（React Context）。
//
// 共有しているのは「サイドバーとチャット一覧ページの両方が使うチャット一覧」と「モデル一覧」だけ。
// 個別チャットのメッセージは ChatView の中だけで使うので、ここには置かない。
// この程度の規模なら Redux などの状態管理ライブラリは不要と判断し、Context だけで済ませている。

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import type { ChatSummary, ModelsInfo } from "./types";

interface AppState {
  /** 更新が新しい順のチャット一覧 */
  chats: ChatSummary[];
  /** 初回の読み込みが終わったか（「まだチャットはありません」を読み込み中に出さないため） */
  chatsLoaded: boolean;
  /** サーバーから一覧を取り直す */
  refreshChats: () => Promise<void>;
  /** 削除して、一覧からも取り除く（1 件なら DELETE、複数なら一括削除 API） */
  removeChats: (ids: string[]) => Promise<void>;
  renameChat: (id: string, title: string) => Promise<void>;
  /** 作成・更新したチャットを一覧に反映する（サーバーへの再取得なしで即座に） */
  upsertChat: (chat: ChatSummary) => void;
  /** null = まだ問い合わせ中 */
  models: ModelsInfo | null;
  refreshModels: (force?: boolean) => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [models, setModels] = useState<ModelsInfo | null>(null);

  // 関数は useCallback で固定する。Context の値が変わるたびに、使っている全コンポーネントが
  // 再描画されるので、関数が毎回作り直されて不要な再描画が起きるのを防ぐ。

  const refreshChats = useCallback(async () => {
    try {
      setChats(await api.listChats());
    } finally {
      // 失敗しても「読み込み済み」にして、読み込み中の表示が残り続けないようにする
      setChatsLoaded(true);
    }
  }, []);

  const refreshModels = useCallback(async (force = false) => {
    try {
      setModels(await api.models(force));
    } catch (e) {
      // backend 自体に届かない場合も「未接続」として扱い、画面に警告を出す
      setModels({ models: [], default: null, available: false, error: String(e) });
    }
  }, []);

  const removeChats = useCallback(async (ids: string[]) => {
    if (ids.length === 1) await api.deleteChat(ids[0]);
    else await api.bulkDelete(ids);
    // 削除が成功してから一覧から消す（失敗したのに消えて見える、ということがないように）
    setChats((prev) => prev.filter((c) => !ids.includes(c.id)));
  }, []);

  const renameChat = useCallback(async (id: string, title: string) => {
    const updated = await api.updateChat(id, { title });
    setChats((prev) => prev.map((c) => (c.id === id ? updated : c)));
  }, []);

  const upsertChat = useCallback((chat: ChatSummary) => {
    setChats((prev) => {
      const rest = prev.filter((c) => c.id !== chat.id);
      // updated_at は ISO 8601 の文字列なので、文字列比較でそのまま時刻順になる
      return [chat, ...rest].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    });
  }, []);

  // 起動時に一度だけ取得する
  useEffect(() => {
    refreshChats().catch(() => {});
    refreshModels().catch(() => {});
  }, [refreshChats, refreshModels]);

  // value のオブジェクトも useMemo で固定し、中身が変わったときだけ利用側を再描画させる
  const value = useMemo(
    () => ({ chats, chatsLoaded, refreshChats, removeChats, renameChat, upsertChat, models, refreshModels }),
    [chats, chatsLoaded, refreshChats, removeChats, renameChat, upsertChat, models, refreshModels],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 共有状態を使うためのフック。AppProvider の外で使うと、すぐ気付けるよう例外にする。 */
export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside AppProvider");
  return v;
}
