/**
 * 入力欄。
 *
 * shadcn-chatbot-kit の message-input.tsx を土台に、添付・音声を落として
 * 自動リサイズと Cmd+Enter 送信だけ残した版。出典: 同 (MIT)
 */

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "../lib/utils.js";

export interface ComposerProps {
  value: string;
  busy: boolean;
  onChange(v: string): void;
  onSubmit(): void;
  /** 実行中のターンを中断する。 */
  onStop(): void;
  /** 待機中の指示。順番に実行される。 */
  queued: string[];
}

export function Composer({ value, busy, queued, onChange, onSubmit, onStop }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // 待機中の中身は既定で開く。件数だけ見せても何を投げたか思い出せないので、
  // 「畳んであるものを開く」より「出ているものを畳む」ほうが既定として妥当。
  const [showQueue, setShowQueue] = useState(true);

  // 入力に合わせて伸ばす。上限は画面の 40%。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [value]);

  // 走っている最中でも送れる。拡張側がキューに積んで順に流す。
  const ready = value.trim().length > 0;

  return (
    <div className="px-3 pb-3">
      {showQueue && queued.length > 0 && (
        <div className="mb-1.5 max-h-[22vh] overflow-y-auto rounded-md bg-muted px-2.5 py-2 text-[11.5px]">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            順番待ち（上から実行される）
          </div>
          {queued.map((text, i) => (
            <div key={i} className="flex gap-1.5 py-0.5">
              <span className="shrink-0 text-muted-foreground">{i + 1}.</span>
              <span className="min-w-0 flex-1 break-words">{text}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-[10px] border border-border bg-input px-2.5 py-2">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          placeholder="指示を書く…"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (ready) onSubmit();
            }
            // 走っている間は Esc で止める。入力欄から手を離さずに中断できる。
            if (e.key === "Escape" && busy) {
              e.preventDefault();
              onStop();
            }
          }}
          className="no-frame max-h-[40vh] flex-1 resize-none bg-transparent font-sans leading-relaxed placeholder:text-muted-foreground"
        />
        {/* 実行中も送信できるので、停止は独立したボタンにする */}
        {busy && (
          <button
            type="button"
            onClick={onStop}
            title="中断（Esc）"
            className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-destructive text-destructive-foreground"
          >
            <Square className="h-3 w-3" fill="currentColor" />
          </button>
        )}
        <button
          type="button"
          disabled={!ready}
          onClick={onSubmit}
          title={busy ? "送信（順番待ちに入る）" : "送信"}
          className={cn(
            "grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity",
            ready ? "opacity-100" : "cursor-default opacity-35",
          )}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="pt-1.5 pr-0.5 text-right text-[10.5px] text-muted-foreground">
        {queued.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowQueue((v) => !v)}
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            {queued.length} 件が順番待ち（{showQueue ? "隠す" : "見る"}） · Esc で中断
          </button>
        ) : busy ? (
          "実行中（送ると順番待ちに入る） · Esc で中断"
        ) : (
          "Cmd + Enter で送信"
        )}
      </div>
    </div>
  );
}
