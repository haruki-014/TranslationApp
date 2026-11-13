// 新しいチャット画面（"/"）。Claude のホーム画面のように、あいさつと大きな入力欄を中央に置く。
//
// 送信したときの流れ:
//   1. ここで選んだ翻訳設定でチャットを作成する（POST /api/chats）
//   2. 作成したチャットの画面（/chat/:id）へ移動し、原文を「移動先に渡す状態（location.state）」に載せる
//   3. 移動先の ChatView が原文を受け取って送信し、翻訳を表示する
// 翻訳のストリーミング処理を ChatView の 1 か所にまとめるため、ここでは翻訳を始めずに渡すだけにしている。

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Composer } from "../components/Composer";
import { LogoMark } from "../components/Icons";
import { useApp } from "../store";
import { DEFAULT_SETTINGS, type ChatSettings } from "../types";

// 前回選んだ翻訳設定を覚えておくキー。毎回「英→日」などを選び直さなくて済むようにする。
const STORAGE_KEY = "plamo:last-settings";

function loadSettings(): ChatSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // 保存したあとで設定項目が増えても壊れないよう、既定値の上に重ねる。
    // 参考文脈はチャットごとの内容なので引き継がない。
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw), context: null };
  } catch {
    /* 読めなければ既定値を使う */
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(s: ChatSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...s, context: null }));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

// よく使う翻訳方向をワンクリックで選べるボタン
const PRESETS: { label: string; patch: Partial<ChatSettings> }[] = [
  { label: "日本語 → 英語", patch: { source_lang: "ja", target_lang: "en" } },
  { label: "英語 → 日本語", patch: { source_lang: "en", target_lang: "ja" } },
  { label: "やさしい日本語に", patch: { source_lang: "ja", target_lang: "ja(easy)" } },
  { label: "中国語（簡体字）に", patch: { source_lang: "auto", target_lang: "zh-hans" } },
  { label: "韓国語に", patch: { source_lang: "auto", target_lang: "ko" } },
];

/** 時間帯に応じたあいさつ（Claude のホーム画面の雰囲気に合わせる） */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "こんばんは";
  if (h < 11) return "おはようございます";
  if (h < 18) return "こんにちは";
  return "こんばんは";
}

export default function NewChat() {
  const navigate = useNavigate();
  const { upsertChat } = useApp();
  const [settings, setSettings] = useState<ChatSettings>(loadSettings);
  const [error, setError] = useState<string | null>(null);
  // チャット作成中の二重送信を防ぐ
  const [busy, setBusy] = useState(false);

  // まだチャットが存在しないので、設定はサーバーではなく画面内と localStorage に保存する
  const update = (patch: Partial<ChatSettings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });
  };

  const send = async (text: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const chat = await api.createChat(settings);
      // サイドバーにすぐ表示されるよう、一覧の再取得を待たずに追加する
      upsertChat(chat);
      navigate(`/chat/${chat.id}`, { state: { pending: text } });
    } catch (e) {
      setError(`チャットを作成できませんでした: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  return (
    <div className="home">
      <div className="home-inner">
        <h1 className="home-greeting">
          <LogoMark size={36} />
          <span>{greeting()}</span>
        </h1>
        <p className="home-sub">PLaMo で翻訳しましょう。文章を入力すると、ローカルのモデルが翻訳します。</p>
        <Composer onSend={send} settings={settings} onSettingsChange={update} autoFocus />
        {error && <div className="banner error">{error}</div>}
        <div className="presets">
          {PRESETS.map((p) => {
            // 今の設定と一致するプリセットを強調表示する
            const active = settings.source_lang === p.patch.source_lang && settings.target_lang === p.patch.target_lang;
            return (
              <button key={p.label} className={`preset ${active ? "active" : ""}`} onClick={() => update(p.patch)}>
                {p.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
