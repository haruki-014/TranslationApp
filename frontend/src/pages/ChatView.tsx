// 個別チャット画面（"/chat/:id"）。翻訳のストリーミング表示を担う、アプリの中心となる画面。
//
// 原文を送ってから訳文が確定するまでの流れ:
//   1. 送信した瞬間に、原文（仮）と空の訳文（仮、pending）を画面に追加する
//      → サーバーの応答を待たずに反応するので、操作が軽く感じられる
//   2. サーバーから SSE イベントが届くたびに表示を更新する
//        user  … 仮の原文を、保存された本物（正しい ID 付き）に置き換える
//        start … 訳文に言語ラベル（→ 英語 など）とモデル名を付ける
//        delta … 訳文の末尾に文字を足していく
//        done  … 仮の訳文を、保存された本物に置き換える
//        error … 訳文の下にエラーを表示する
//   3. 停止ボタンを押すと fetch を中断する。サーバーは途中までの訳を「停止した訳」として保存する
//
// 仮のメッセージには負の ID を振り、サーバーの ID（正の連番）とぶつからないようにしている。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api, streamEvents } from "../api";
import { Composer } from "../components/Composer";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ChevronDownIcon, PencilIcon, TrashIcon } from "../components/Icons";
import { MessageItem, type UIMessage } from "../components/MessageItem";
import { Popover } from "../components/Popover";
import { useApp } from "../store";
import type { ChatDetail, ChatSettings, StreamEvent } from "../types";

export default function ChatView() {
  const { id } = useParams();
  // key に ID を指定し、別のチャットへ移動したらコンポーネントを丸ごと作り直す。
  // こうしないと、チャット A の翻訳中にチャット B へ移動したとき、A のストリームの更新が
  // B の画面に混ざってしまう。作り直せば A の更新は破棄済みのコンポーネントに向かうだけで、表示に影響しない。
  // （A の翻訳自体はサーバーで最後まで続き、保存される）
  return <ChatViewInner key={id} id={id!} />;
}

// 仮メッセージ用の ID（-1, -2, -3, ...）
let tempSeq = 0;
const tempId = () => -(++tempSeq);

/** 送信直後に画面へ出す仮のメッセージ */
function blankMessage(role: UIMessage["role"], content = ""): UIMessage {
  return {
    id: tempId(),
    role,
    content,
    source_lang: null,
    target_lang: null,
    model: null,
    cached: false,
    stopped: false,
    created_at: new Date().toISOString(),
  };
}

function ChatViewInner({ id }: { id: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { refreshChats, upsertChat, removeChats, renameChat } = useApp();

  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);

  // 描画に関係しない値は useRef に持つ（変えても再描画を起こさない）
  const abortRef = useRef<AbortController | null>(null); // 翻訳中のリクエストを中断するため
  const pendingSent = useRef(false); // ホーム画面から渡された原文を送ったか（二重送信防止）
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true); // 最下部に追従するか（ユーザーが上へスクロールしたら止める）

  // ---- ストリーミングの共通処理（送信と再翻訳で共用）
  // userTempId: 置き換える仮の原文の ID（再翻訳では原文を追加しないので null）
  // asstTempId: 書き換えていく仮の訳文の ID
  const run = useCallback(
    async (path: string, body: unknown, userTempId: number | null, asstTempId: number) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);
      // 新しく送ったときは、訳文が伸びていく様子が見えるよう最下部に追従させる
      stickToBottom.current = true;

      // 仮の訳文だけを書き換えるヘルパー。
      // setMessages には必ず関数を渡し、常に最新の一覧に対して更新する
      // （delta は短い間隔で大量に届くので、古い一覧を基に更新すると文字が抜ける）。
      const patchAsst = (fn: (m: UIMessage) => UIMessage) =>
        setMessages((ms) => ms.map((m) => (m.id === asstTempId ? fn(m) : m)));

      const onEvent = (e: StreamEvent) => {
        switch (e.type) {
          case "user":
            if (userTempId !== null) setMessages((ms) => ms.map((m) => (m.id === userTempId ? e.message : m)));
            // 最初のメッセージで付いた自動タイトルを、ヘッダーとサイドバーに反映する
            setChat((c) => (c ? { ...c, title: e.title } : c));
            refreshChats().catch(() => {});
            break;
          case "start":
            patchAsst((m) => ({ ...m, model: e.model, source_lang: e.source_lang, target_lang: e.target_lang }));
            break;
          case "delta":
            patchAsst((m) => ({ ...m, content: m.content + e.content }));
            break;
          case "done":
            setMessages((ms) => ms.map((m) => (m.id === asstTempId ? e.message : m)));
            break;
          case "error":
            patchAsst((m) => ({ ...m, pending: false, error: e.error }));
            break;
        }
      };

      try {
        await streamEvents(path, body, onEvent, controller.signal);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // 停止ボタンによる中断。エラーではなく「停止しました」と表示する
          patchAsst((m) => ({ ...m, pending: false, stopped: true }));
        } else {
          // ネットワークエラーなど、サーバーからエラーイベントが届かなかった失敗
          patchAsst((m) => ({ ...m, pending: false, error: (err as Error).message }));
        }
      } finally {
        // どの終わり方でも「受信中」の表示が残らないようにする
        patchAsst((m) => (m.pending ? { ...m, pending: false } : m));
        setStreaming(false);
        abortRef.current = null;
        // サイドバーの並び順（最終更新）を反映する
        refreshChats().catch(() => {});
      }
    },
    [refreshChats],
  );

  /** 原文を送って翻訳する */
  const send = useCallback(
    (text: string) => {
      const user = blankMessage("user", text);
      const asst = { ...blankMessage("assistant"), pending: true };
      setMessages((ms) => [...ms, user, asst]);
      return run(`/api/chats/${id}/messages`, { content: text }, user.id, asst.id);
    },
    [id, run],
  );

  /** 最後の訳文をやり直す。サーバー側でも最後の訳文を削除してから訳し直す。 */
  const regenerate = useCallback(() => {
    const asst = { ...blankMessage("assistant"), pending: true };
    setMessages((ms) => {
      const copy = [...ms];
      if (copy.length && copy[copy.length - 1].role === "assistant") copy.pop();
      return [...copy, asst];
    });
    return run(`/api/chats/${id}/regenerate`, undefined, null, asst.id);
  }, [id, run]);

  // ---- 読み込み。ホーム画面から原文が渡されていれば、読み込み後に送信する
  useEffect(() => {
    api
      .getChat(id)
      .then((c) => {
        setChat(c);
        setMessages(c.messages);
        const pending = (location.state as { pending?: string } | null)?.pending;
        if (pending && !pendingSent.current) {
          pendingSent.current = true;
          // 渡された状態を履歴から消す。消さないと、ページを再読み込みしたり「戻る→進む」で
          // この画面に戻ったりしたときに、同じ原文がもう一度送信されてしまう。
          navigate(location.pathname, { replace: true, state: null });
          send(pending);
        }
      })
      .catch((e) => setLoadError((e as Error).message));
    // 依存は id だけにしている。location や send を含めると、上の navigate（state の削除）で
    // location が変わったときにチャットを読み込み直してしまうため。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ---- 自動スクロール
  // useLayoutEffect は描画の直前に実行されるので、新しい文字が見えてからスクロールする「ちらつき」が起きない
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ユーザーが上へスクロールして過去の訳文を読んでいる間は、勝手に最下部へ戻さない。
  // 最下部から 80px 以内まで戻ってきたら、また追従を再開する。
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  /** 翻訳設定の変更。画面には先に反映し（楽観的更新）、サーバーへの保存は後から行う。 */
  const updateSettings = async (patch: Partial<ChatSettings>) => {
    if (!chat) return;
    setChat({ ...chat, ...patch });
    try {
      upsertChat(await api.updateChat(id, patch));
    } catch (e) {
      alert(`設定を保存できませんでした: ${(e as Error).message}`);
    }
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    // 翻訳中に削除した場合は、先にストリームを止める
    abortRef.current?.abort();
    await removeChats([id]);
    navigate("/");
  };

  if (loadError) {
    // 削除済みのチャットの URL を開いた場合など
    return (
      <div className="center-message">
        <p>チャットを読み込めませんでした（{loadError}）</p>
        <button className="btn btn-primary" onClick={() => navigate("/")}>
          新しいチャットへ
        </button>
      </div>
    );
  }
  if (!chat) return <div className="center-message muted">読み込み中…</div>;

  const last = messages[messages.length - 1];

  return (
    <div className="chat-view">
      {/* ヘッダー: チャット名。押すと「名前を変更」「削除」のメニュー（Claude と同じ配置） */}
      <header className="chat-header">
        {renaming ? (
          <input
            className="rename-input header"
            autoFocus
            defaultValue={chat.title}
            maxLength={200}
            onFocus={(e) => e.target.select()}
            onBlur={async (e) => {
              setRenaming(false);
              const t = e.target.value.trim();
              if (t && t !== chat.title) {
                setChat({ ...chat, title: t });
                await renameChat(id, t);
              }
            }}
            onKeyDown={(e) => {
              // Enter は blur させて、確定処理を onBlur の 1 か所にまとめる
              if (e.key === "Enter" && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <Popover
            placement="bottom"
            trigger={(open, toggle) => (
              <button className={`title-btn ${open ? "active" : ""}`} onClick={toggle}>
                <span className="title-text">{chat.title}</span>
                <ChevronDownIcon size={15} />
              </button>
            )}
          >
            {(close) => (
              <div className="menu compact">
                <button
                  className="menu-item"
                  onClick={() => {
                    close();
                    setRenaming(true);
                  }}
                >
                  <PencilIcon size={15} />
                  <span>名前を変更</span>
                </button>
                <button
                  className="menu-item danger"
                  onClick={() => {
                    close();
                    setConfirmDelete(true);
                  }}
                >
                  <TrashIcon size={15} />
                  <span>削除</span>
                </button>
              </div>
            )}
          </Popover>
        )}
      </header>

      {/* メッセージ一覧（この領域だけがスクロールし、入力欄は下に固定される） */}
      <div className="messages" ref={scrollRef} onScroll={onScroll}>
        <div className="messages-inner">
          {messages.length === 0 && <div className="empty-chat">翻訳したい文章を入力してください。</div>}
          {messages.map((m) => (
            <MessageItem
              key={m.id}
              message={m}
              isLast={m === last}
              canRetry={!streaming}
              onRetry={regenerate}
            />
          ))}
        </div>
      </div>

      <div className="composer-dock">
        <Composer
          onSend={send}
          onStop={() => abortRef.current?.abort()}
          streaming={streaming}
          // ChatDetail は ChatSettings の項目をすべて持つので、そのまま設定として渡せる
          settings={chat}
          onSettingsChange={updateSettings}
          placeholder="続けて翻訳する文章を入力…"
          autoFocus
        />
        <div className="disclaimer">翻訳結果は誤りを含む場合があります。重要な内容は必ず確認してください。</div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="チャットを削除"
        message={`「${chat.title}」を削除しますか？この操作は取り消せません。`}
        confirmLabel="削除"
        danger
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
