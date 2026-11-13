// バックエンド API と共有するデータ型。
// backend/app/schemas.py の Pydantic モデルと 1 対 1 で対応させている。
// どちらかを変えたら、もう一方も合わせて変えること。

export type Role = "user" | "assistant";
/** 日本語訳の文体。polite = 敬体（です・ます）、plain = 常体（だ・である）、null = 指定なし */
export type Form = "polite" | "plain" | null;

/** 1 件の発言。user が原文、assistant が訳文。 */
export interface Message {
  /** サーバーで採番される連番。画面で仮表示している間は負の値（ChatView.tsx の tempId）を使う */
  id: number;
  role: Role;
  content: string;
  /** 原文の言語（明示されていた場合のみ。自動判定なら null） */
  source_lang: string | null;
  /** 訳した先の言語（"auto" を解決した後の値） */
  target_lang: string | null;
  model: string | null;
  /** Redis の翻訳キャッシュから返した訳か */
  cached: boolean;
  /** ユーザーが途中で停止した訳か */
  stopped: boolean;
  created_at: string;
}

/** チャット単位の翻訳設定。ホーム画面でもチャット画面でも、同じ入力欄（Composer）で編集する。 */
export interface ChatSettings {
  /** null = サーバーの既定モデルを自動選択 */
  model: string | null;
  /** "auto" = モデルに判定させる */
  source_lang: string;
  /** "auto" = 日本語なら英語へ、それ以外なら日本語へ */
  target_lang: string;
  form: Form;
  /** 参考文脈（原文を解釈するための場面・読者などの説明） */
  context: string | null;
  /** 過去の対訳をプロンプトに含めて、用語や文体を揃えるか */
  use_history: boolean;
}

/** 一覧用（メッセージを含まない） */
export interface ChatSummary extends ChatSettings {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** 個別チャット画面用（メッセージを含む） */
export interface ChatDetail extends ChatSummary {
  messages: Message[];
}

/** GET /api/models の結果 */
export interface ModelsInfo {
  models: { id: string; is_plamo: boolean }[];
  /** 自動選択で使われるモデル */
  default: string | null;
  /** モデルサーバーに接続できたか */
  available: boolean;
  error?: string | null;
}

/**
 * 翻訳ストリーム（SSE）で届くイベント。
 * type で判別できる「判別共用体」にしておくと、switch 文の中で各イベントの型が自動で絞り込まれる。
 * 送信側は backend/app/routers/chats.py の _translate_stream。
 */
export type StreamEvent =
  | { type: "user"; message: Message; title: string }
  | { type: "start"; model: string; source_lang: string | null; target_lang: string }
  | { type: "delta"; content: string }
  | { type: "done"; message: Message }
  | { type: "error"; error: string };

/** 新しいチャットの初期設定（バックエンドの既定値と同じ） */
export const DEFAULT_SETTINGS: ChatSettings = {
  model: null,
  source_lang: "auto",
  target_lang: "auto",
  form: null,
  context: null,
  use_history: true,
};
