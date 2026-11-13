// 1 件のメッセージの表示。
//
// Claude の見た目に合わせて:
//   - 原文（user）  … 右寄せのベージュの吹き出し
//   - 訳文（assistant）… 吹き出しなしで全幅、明朝体（serif）。下にコピー・再翻訳などの操作ボタン
//
// 訳文は Markdown として描画せず、プレーンテキスト（white-space: pre-wrap）で表示している。
// 翻訳結果は原文の記号（* や # など）をそのまま含むことが多く、Markdown として解釈すると
// 見た目が変わってしまい「訳文をそのままコピーして使う」用途に合わないため。

import { useState } from "react";
import { langLabel } from "../languages";
import type { Message } from "../types";
import { CheckIcon, CopyIcon, RetryIcon } from "./Icons";

/**
 * 画面表示用のメッセージ。サーバーから来た Message に、表示だけで使う状態を足したもの。
 *   pending … 訳文を受信中（カーソルの点滅や「考え中」の表示に使う）
 *   error   … 翻訳に失敗したときの文言
 */
export type UIMessage = Message & { pending?: boolean; error?: string };

interface Props {
  message: UIMessage;
  /** 最後のメッセージか（再翻訳ボタンは最後の訳文にだけ出す） */
  isLast: boolean;
  /** 翻訳中は再翻訳できない */
  canRetry: boolean;
  onRetry: () => void;
}

export function MessageItem({ message, isLast, canRetry, onRetry }: Props) {
  if (message.role === "user") {
    return (
      <div className="msg-row user">
        <div className="user-bubble">{message.content}</div>
      </div>
    );
  }
  return <AssistantMessage message={message} isLast={isLast} canRetry={canRetry} onRetry={onRetry} />;
}

function AssistantMessage({ message, isLast, canRetry, onRetry }: Props) {
  const [copied, setCopied] = useState(false);
  const { pending, error, content } = message;
  // 送信直後で、まだ 1 文字も届いていない状態
  const waiting = pending && !content;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      // コピーしたことが分かるよう、1.5 秒だけチェックマークに変える
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* クリップボードが使えない環境（http の非 localhost など）では何もしない */
    }
  };

  return (
    <div className={`msg-row assistant ${isLast ? "last" : ""}`}>
      {/* どの言語に訳したかを小さく表示する。自動判定の結果がひと目で分かるように。 */}
      {message.target_lang && (
        <div className="msg-meta">
          {message.source_lang ? `${langLabel(message.source_lang)} → ` : "→ "}
          {langLabel(message.target_lang)}
        </div>
      )}
      <div className="assistant-text">
        {waiting ? (
          // 最初の文字が届くまでの「考え中」アニメーション（3 つの点）
          <span className="thinking">
            <span />
            <span />
            <span />
          </span>
        ) : (
          <>
            {content}
            {/* 受信中は末尾に点滅する丸を出し、まだ続きが来ることを示す */}
            {pending && <span className="cursor" />}
          </>
        )}
      </div>
      {error && <div className="msg-error">{error}</div>}
      {/* 操作ボタンは受信が終わってから出す（途中の訳文をコピーされないように） */}
      {!pending && (
        <div className="msg-actions">
          {content && (
            <button className="icon-btn small" onClick={copy} title="コピー">
              {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
            </button>
          )}
          {isLast && canRetry && (
            <button className="icon-btn small" onClick={onRetry} title="再翻訳">
              <RetryIcon size={15} />
            </button>
          )}
          {message.stopped && <span className="tag">停止しました</span>}
          {message.cached && <span className="tag" title="同じ条件の翻訳結果を Redis から再利用しました">キャッシュ</span>}
          {message.model && <span className="msg-model">{message.model}</span>}
        </div>
      )}
    </div>
  );
}
