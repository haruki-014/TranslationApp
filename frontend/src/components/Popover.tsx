// 汎用のポップオーバー（ボタンの近くに浮かぶ小さなパネル）。
// モデル選択、言語選択、翻訳オプション、サイドバーの「…」メニューなどで共通に使う。
//
// 使い方は「render props」形式:
//   trigger  … 開閉ボタンを描く関数。open（開いているか）と toggle（開閉する関数）を受け取る
//   children … パネルの中身を描く関数。close（閉じる関数）を受け取る。項目を選んだら閉じる、などに使う
// 開閉状態をこのコンポーネントの中に閉じ込め、使う側で useState を書かずに済むようにしている。

import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  /** パネルをボタンの左端に揃えるか、右端に揃えるか */
  align?: "left" | "right";
  /**
   * パネルをボタンの上に出すか、下に出すか。
   * 入力欄は画面の下端にあるので既定は上（top）。ヘッダーやサイドバーのメニューは下（bottom）。
   */
  placement?: "top" | "bottom";
  className?: string;
}

/** パネルの外をクリックするか Esc を押すと閉じる */
export function Popover({ trigger, children, align = "left", placement = "top", className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 開いている間だけ document にイベントを登録する（閉じているときに無駄な処理をしないため）
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // ボタンとパネルを包む要素の「外側」がクリックされたら閉じる。
      // click ではなく mousedown を使うのは、パネル内のテキスト選択などをドラッグして
      // 外で指を離したときに閉じてしまうのを防ぐため。
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    // position: relative の基準要素。パネルはこの要素からの相対位置で配置される（styles.css）
    <div className="popover-anchor" ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div className={`popover popover-${placement} popover-${align} ${className}`} role="dialog">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
