// 日時の表示用ユーティリティ。

/** 「3分前」「2日前」のような相対表記。30 日以上前は日付で表示する。 */
export function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000; // 経過秒数
  if (diff < 60) return "たった今";
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}日前`;
  return d.toLocaleDateString("ja-JP");
}

/** サイドバーの見出し。Claude のサイドバーと同じく、最終更新日で会話をまとめる。 */
export type Group = "今日" | "昨日" | "過去7日間" | "過去30日間" | "それ以前";

/**
 * 日時がどのグループに入るか。
 * 「今日」は経過時間（24 時間以内）ではなく、ブラウザのタイムゾーンでの暦日で判定する
 * （夜 23 時の会話が翌朝も「今日」に残っていると不自然なため）。
 */
export function dateGroup(iso: string): Group {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  const day = 86400000;
  if (t >= startOfToday) return "今日";
  if (t >= startOfToday - day) return "昨日";
  if (t >= startOfToday - 7 * day) return "過去7日間";
  if (t >= startOfToday - 30 * day) return "過去30日間";
  return "それ以前";
}
