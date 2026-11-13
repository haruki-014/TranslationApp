// 入力欄（Claude の入力ボックスに相当する部分）。
//
// ホーム画面（新しいチャット）と個別チャット画面の両方で、同じコンポーネントを使う。
// 入力欄の下のツールバーに、翻訳に関わる設定をまとめて置いている:
//   左: [翻訳オプション（文体・参考文脈・対訳履歴）] [翻訳方向]
//   右: [モデル選択] [送信 / 停止]
// 設定の保存先は呼び出し側に任せる（onSettingsChange）。
//   - ホーム画面: まだチャットがないので、画面内の状態と localStorage に保存
//   - チャット画面: そのチャットの設定として即座にサーバーへ PATCH

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LANGUAGES, langLabel, targetLabel } from "../languages";
import { useApp } from "../store";
import type { ChatSettings } from "../types";
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, RefreshIcon, SlidersIcon, StopIcon, SwapIcon } from "./Icons";
import { Popover } from "./Popover";

interface Props {
  onSend: (text: string) => void;
  onStop?: () => void;
  /** 翻訳中か。翻訳中は送信ボタンが停止ボタンに変わる */
  streaming?: boolean;
  settings: ChatSettings;
  onSettingsChange: (patch: Partial<ChatSettings>) => void;
  placeholder?: string;
  autoFocus?: boolean;
  initialText?: string;
}

export function Composer({
  onSend,
  onStop,
  streaming = false,
  settings,
  onSettingsChange,
  placeholder = "翻訳したい文章を入力…",
  autoFocus,
  initialText,
}: Props) {
  const [text, setText] = useState(initialText ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (initialText !== undefined) setText(initialText);
  }, [initialText]);

  // ---- 入力に合わせて高さを自動調整する
  // 一度 height を auto に戻してから scrollHeight（中身の高さ）を測り、その高さに合わせる。
  // 上限（320px）を超えたら、それ以上は伸ばさずに textarea 内でスクロールさせる。
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  };
  useEffect(fit, [text]);
  // 幅が変わると折り返し位置が変わり、必要な高さも変わるので測り直す。
  // （画面の初回表示時に幅が狭い状態で測られ、入力欄が異様に縦長になる問題があったための対策）
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      // fit() で高さを変えると ResizeObserver がまた呼ばれるので、幅が変わったときだけ測り直す（無限ループ防止）
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // 空白だけの入力は送らない。翻訳中は二重送信させない。
  const canSend = text.trim().length > 0 && !streaming;

  const submit = () => {
    if (!canSend) return;
    onSend(text);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter で送信、Shift+Enter で改行（Claude と同じ操作）。
    // ただし日本語入力（IME）で変換を確定する Enter では送信しない。
    // isComposing が変換中を表すが、Safari では確定の Enter で false になることがあるため、
    // 変換中のキー入力を表す keyCode 229 も合わせて判定している。
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        className="composer-input"
        value={text}
        rows={1}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-toolbar">
        <div className="composer-left">
          <SettingsButton settings={settings} onChange={onSettingsChange} />
          <LanguageButton settings={settings} onChange={onSettingsChange} />
        </div>
        <div className="composer-right">
          <ModelButton value={settings.model} onChange={(model) => onSettingsChange({ model })} />
          {streaming ? (
            <button className="send-btn" onClick={onStop} aria-label="停止" title="停止">
              <StopIcon size={16} />
            </button>
          ) : (
            <button className="send-btn" onClick={submit} disabled={!canSend} aria-label="送信" title="送信 (Enter)">
              <ArrowUpIcon size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 翻訳方向（翻訳元 → 翻訳先）を選ぶボタンとパネル */
function LanguageButton({ settings, onChange }: { settings: ChatSettings; onChange: (p: Partial<ChatSettings>) => void }) {
  const { source_lang: src, target_lang: tgt } = settings;
  // 両方とも自動のときは「自動（日⇄英）」とだけ表示し、「自動 → 自動」のような分かりにくい表記を避ける
  const label = tgt === "auto" && src === "auto" ? "自動（日⇄英）" : `${langLabel(src)} → ${targetLabel(tgt)}`;
  // 入れ替えは両方が具体的な言語のときだけ意味がある（「自動」同士を入れ替えても意味が変わってしまう）
  const canSwap = src !== "auto" && tgt !== "auto";

  return (
    <Popover
      trigger={(open, toggle) => (
        <button className={`chip ${open ? "active" : ""}`} onClick={toggle} title="翻訳方向">
          <span>{label}</span>
          <ChevronDownIcon size={14} />
        </button>
      )}
    >
      {() => (
        <div className="lang-panel">
          {/* 53 言語あるので、独自のリストではなくネイティブの select を使う（キーボード操作・検索がそのまま効く） */}
          <label className="field">
            <span className="field-label">翻訳元</span>
            <select value={src} onChange={(e) => onChange({ source_lang: e.target.value })}>
              <option value="auto">自動検出</option>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="icon-btn swap-btn"
            disabled={!canSwap}
            title="入れ替え"
            onClick={() => onChange({ source_lang: tgt, target_lang: src })}
          >
            <SwapIcon size={16} />
          </button>
          <label className="field">
            <span className="field-label">翻訳先</span>
            <select value={tgt} onChange={(e) => onChange({ target_lang: e.target.value })}>
              <option value="auto">自動（日本語⇄英語）</option>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">「自動」では、日本語の文章は英語に、それ以外は日本語に翻訳します。</p>
        </div>
      )}
    </Popover>
  );
}

/** 翻訳オプション（文体・参考文脈・対訳履歴）のボタンとパネル */
function SettingsButton({ settings, onChange }: { settings: ChatSettings; onChange: (p: Partial<ChatSettings>) => void }) {
  // 参考文脈は 1 文字ごとに保存すると、チャット画面では入力のたびに PATCH が飛んでしまう。
  // そこで入力中は手元の状態に溜め、欄からフォーカスが外れたときにまとめて保存する。
  const [ctx, setCtx] = useState(settings.context ?? "");
  useEffect(() => setCtx(settings.context ?? ""), [settings.context]);
  // 文体の指定はモデルの仕様上、日本語訳のときだけ有効（自動なら日本語に訳す場合があるので有効にしておく）
  const formEnabled = settings.target_lang === "ja" || settings.target_lang === "auto";
  // 既定から変えている項目があれば、ボタンを強調表示して「何か設定されている」ことを示す
  const hasCustom = !!settings.context || !!settings.form || !settings.use_history;

  return (
    <Popover
      className="settings-popover"
      trigger={(open, toggle) => (
        <button className={`icon-btn bordered ${open || hasCustom ? "active" : ""}`} onClick={toggle} title="翻訳オプション">
          <SlidersIcon size={17} />
        </button>
      )}
    >
      {() => (
        <div className="settings-panel">
          <div className="settings-title">翻訳オプション</div>
          <label className="field">
            <span className="field-label">日本語の文体</span>
            <select
              value={settings.form ?? ""}
              disabled={!formEnabled}
              // select の値は文字列なので、「指定なし」（空文字）を null に戻して保存する
              onChange={(e) => onChange({ form: (e.target.value || null) as ChatSettings["form"] })}
            >
              <option value="">指定なし</option>
              <option value="polite">敬体（です・ます）</option>
              <option value="plain">常体（だ・である）</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">参考文脈</span>
            <textarea
              rows={3}
              value={ctx}
              placeholder="例: 社内向けの技術ドキュメント。読者はエンジニア。"
              onChange={(e) => setCtx(e.target.value)}
              // 変わっていなければ保存しない。空白だけなら「参考文脈なし」（null）として保存する。
              onBlur={() => ctx !== (settings.context ?? "") && onChange({ context: ctx.trim() ? ctx : null })}
            />
          </label>
          <label className="toggle-row">
            <span>
              <span className="field-label">対訳履歴を使う</span>
              <span className="hint">このチャットの過去の訳文を参考に、用語や文体を揃えます。</span>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={settings.use_history}
              onChange={(e) => onChange({ use_history: e.target.checked })}
            />
          </label>
        </div>
      )}
    </Popover>
  );
}

/** モデル選択のボタンとメニュー */
function ModelButton({ value, onChange }: { value: string | null; onChange: (m: string | null) => void }) {
  const { models, refreshModels } = useApp();
  // 未指定（自動選択）のときは、実際に使われるモデル（サーバーの既定）を表示する
  const current = value ?? models?.default ?? null;
  const label = current ? shortModel(current) : models?.available === false ? "モデル未接続" : "モデル";

  return (
    <Popover
      align="right"
      className="model-popover"
      trigger={(open, toggle) => (
        <button className={`chip ghost ${open ? "active" : ""}`} onClick={toggle} title={current ?? ""}>
          <span className="model-label">{label}</span>
          <ChevronDownIcon size={14} />
        </button>
      )}
    >
      {(close) => (
        <div className="menu">
          <div className="menu-header">
            <span>利用可能なモデル</span>
            {/* サーバー側でモデルを入れ替えたときに、キャッシュを待たずに一覧を取り直す */}
            <button className="icon-btn small" title="再読み込み" onClick={() => refreshModels(true)}>
              <RefreshIcon size={14} />
            </button>
          </div>
          {models?.available === false && <div className="menu-error">{models.error}</div>}
          {/* 「自動選択」を選ぶとチャットにモデルを固定しない（null）。サーバーのモデルが変わっても追従する。 */}
          <button
            className="menu-item"
            onClick={() => {
              onChange(null);
              close();
            }}
          >
            <span className="menu-item-text">
              <span>自動選択</span>
              {models?.default && <span className="menu-sub">{models.default}</span>}
            </span>
            {value === null && <CheckIcon size={15} />}
          </button>
          {models?.models.map((m) => (
            <button
              key={m.id}
              className="menu-item"
              onClick={() => {
                onChange(m.id);
                close();
              }}
            >
              <span className="menu-item-text">
                <span>{m.id}</span>
                {/* 呼び出し方が違う（PFML3 か汎用チャットか）ことを利用者にも見せておく */}
                <span className="menu-sub">{m.is_plamo ? "PLaMo 翻訳（PFML3）" : "汎用チャットモデル"}</span>
              </span>
              {value === m.id && <CheckIcon size={15} />}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** ツールバーに収まるよう、モデル ID を短くする（"組織名/" を落とし、長ければ末尾を省略） */
function shortModel(id: string): string {
  const name = id.split("/").pop() ?? id;
  return name.length > 28 ? name.slice(0, 27) + "…" : name;
}
