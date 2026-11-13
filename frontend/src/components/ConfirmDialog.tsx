// 確認ダイアログ（削除の確認に使う）。
//
// ブラウザ標準の confirm() を使わないのは、見た目をアプリに合わせられず、
// 処理全体が止まってしまう（同期的にブロックする）ため。
// 削除は取り消せない操作なので、必ずこのダイアログで確認してから実行する。

import { useEffect } from "react";

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  /** true なら確定ボタンを赤（危険な操作）にする */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel = "OK", danger, onConfirm, onCancel }: Props) {
  // 開いている間は Esc でキャンセルできる
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    // 背景（暗い幕）をクリックするとキャンセル
    <div className="modal-backdrop" onMouseDown={onCancel}>
      {/* ダイアログ内のクリックが背景まで伝わって閉じてしまわないよう、伝播を止める */}
      <div className="modal" role="alertdialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="modal-title">{title}</h2>
        <p className="modal-message">{message}</p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>
            キャンセル
          </button>
          {/* autoFocus: 開いた直後に Enter で確定できるようにする */}
          <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
