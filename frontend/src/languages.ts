// 翻訳言語の一覧と、表示名への変換。
//
// PLaMo 3 Translate が対応する 53 言語（モデル同梱 README の「対応言語」）をすべて載せている。
// code はモデルに渡す言語コードそのもので、バックエンドの検証（schemas.py の _LANG_RE）も同じ形式。
// 並び順はよく使われそうな言語を先頭にし、残りはおおむねコード順にしている。
// ja(easy) は「やさしい日本語」で、翻訳先に指定すると平易な日本語に書き換える。
export const LANGUAGES: { code: string; label: string }[] = [
  { code: "ja", label: "日本語" },
  { code: "ja(easy)", label: "やさしい日本語" },
  { code: "en", label: "英語" },
  { code: "zh-hans", label: "中国語（簡体字）" },
  { code: "zh-hant", label: "中国語（繁体字）" },
  { code: "ko", label: "韓国語" },
  { code: "fr", label: "フランス語" },
  { code: "de", label: "ドイツ語" },
  { code: "es", label: "スペイン語" },
  { code: "it", label: "イタリア語" },
  { code: "ru", label: "ロシア語" },
  { code: "vi", label: "ベトナム語" },
  { code: "th", label: "タイ語" },
  { code: "id", label: "インドネシア語" },
  { code: "ms", label: "マレー語" },
  { code: "tl", label: "タガログ語" },
  { code: "hi", label: "ヒンディー語" },
  { code: "ar", label: "アラビア語" },
  { code: "nl", label: "オランダ語" },
  { code: "pl", label: "ポーランド語" },
  { code: "az", label: "アゼルバイジャン語" },
  { code: "be", label: "ベラルーシ語" },
  { code: "bg", label: "ブルガリア語" },
  { code: "bn", label: "ベンガル語" },
  { code: "ca", label: "カタルーニャ語" },
  { code: "ceb", label: "セブアノ語" },
  { code: "et", label: "エストニア語" },
  { code: "eu", label: "バスク語" },
  { code: "fa", label: "ペルシャ語" },
  { code: "gu", label: "グジャラート語" },
  { code: "he", label: "ヘブライ語" },
  { code: "hr", label: "クロアチア語" },
  { code: "hu", label: "ハンガリー語" },
  { code: "hy", label: "アルメニア語" },
  { code: "jv", label: "ジャワ語" },
  { code: "ka", label: "ジョージア語" },
  { code: "kk", label: "カザフ語" },
  { code: "km", label: "クメール語" },
  { code: "lt", label: "リトアニア語" },
  { code: "lv", label: "ラトビア語" },
  { code: "ml", label: "マラヤーラム語" },
  { code: "mr", label: "マラーティー語" },
  { code: "my", label: "ミャンマー語" },
  { code: "ne", label: "ネパール語" },
  { code: "pa", label: "パンジャーブ語" },
  { code: "si", label: "シンハラ語" },
  { code: "sk", label: "スロバキア語" },
  { code: "sl", label: "スロベニア語" },
  { code: "sr", label: "セルビア語" },
  { code: "sw", label: "スワヒリ語" },
  { code: "ta", label: "タミル語" },
  { code: "te", label: "テルグ語" },
  { code: "ur", label: "ウルドゥー語" },
  { code: "uz", label: "ウズベク語" },
];

// コード → 表示名を引くための Map（配列を毎回探さないように一度だけ作る）
const NAMES = new Map(LANGUAGES.map((l) => [l.code, l.label]));

/** 言語コードの表示名。null や "auto" は「自動」、一覧にないコードはコードのまま表示する。 */
export function langLabel(code: string | null | undefined): string {
  if (!code || code === "auto") return "自動";
  return NAMES.get(code) ?? code;
}

/**
 * 翻訳先としての表示名。翻訳先の "auto" は「何でも自動」ではなく
 * 「日本語⇄英語を自動で切り替える」という意味なので、それが分かる表記にする。
 */
export function targetLabel(code: string): string {
  return code === "auto" ? "自動（日⇄英）" : langLabel(code);
}
