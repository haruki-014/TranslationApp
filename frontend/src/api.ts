// バックエンド API の呼び出しをまとめたモジュール。
//
// パスはすべて "/api/..." の相対パスにしている。
// - Docker 構成: nginx が同じオリジンで /api を backend に中継する（frontend/nginx.conf）
// - 開発時（npm run dev）: Vite の開発サーバーが /api を backend に中継する（vite.config.ts）
// どちらでもブラウザから見て同一オリジンになるので、CORS の設定やベース URL の切り替えが要らない。

import type { ChatDetail, ChatSettings, ChatSummary, ModelsInfo, StreamEvent } from "./types";

/** fetch の薄いラッパー。HTTP エラー時は FastAPI の detail を取り出して Error にする。 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      // FastAPI のエラーは {"detail": "..."}（検証エラーなら配列）の形で返る
      const body = await res.json();
      if (body?.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* 本文が JSON でない場合はステータスだけを使う */
    }
    throw new Error(detail);
  }
  // 204 No Content は本文がないので res.json() を呼ぶと失敗する
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  /** q を渡すとタイトルと本文を検索する */
  listChats: (q?: string) =>
    request<ChatSummary[]>(`/api/chats${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  createChat: (settings: Partial<ChatSettings> & { title?: string }) =>
    request<ChatSummary>("/api/chats", { method: "POST", body: JSON.stringify(settings) }),
  getChat: (id: string) => request<ChatDetail>(`/api/chats/${id}`),
  /** 変えたい項目だけを送る（送らなかった項目はそのまま） */
  updateChat: (id: string, patch: Partial<ChatSettings> & { title?: string }) =>
    request<ChatSummary>(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteChat: (id: string) => request<void>(`/api/chats/${id}`, { method: "DELETE" }),
  bulkDelete: (ids: string[]) =>
    request<{ deleted: number }>("/api/chats/bulk-delete", { method: "POST", body: JSON.stringify({ ids }) }),
  /** refresh=true でサーバー側のキャッシュを使わずに取り直す */
  models: (refresh = false) => request<ModelsInfo>(`/api/models${refresh ? "?refresh=true" : ""}`),
};

/**
 * POST して SSE（text/event-stream）を読み、イベントごとに onEvent を呼ぶ。
 *
 * ブラウザ標準の EventSource は GET しか送れず、原文を本文に載せられないため、
 * fetch のレスポンス本文（ReadableStream）を自前で読んで SSE を解釈している。
 * signal を abort すると fetch が中断され、バックエンドは切断を検知して途中までの訳を保存する。
 */
export async function streamEvents(
  path: string,
  body: unknown,
  onEvent: (e: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // 再翻訳（/regenerate）は本文なしで送る
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    // ストリームが始まる前のエラー（404 など）は通常の JSON で返る
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j?.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // ネットワークの区切りとイベントの区切りは一致しない（1 回の read にイベントが半分だけ、
  // または複数入っていることがある）ので、バッファに溜めて "\n\n"（イベントの終わり）ごとに切り出す。
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    // stream: true … マルチバイト文字（日本語）がチャンクの境目で分断されても正しく復号する
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      // SSE の仕様では 1 イベントに複数の data: 行を含められ、改行でつなげて 1 つのデータにする
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data) as StreamEvent);
    }
  }
}
