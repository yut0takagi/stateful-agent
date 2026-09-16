/**
 * ツール実行カード。
 *
 * Claude Code for VSCode と同じ形 — ツール1回につきカード1枚。
 * 見出し（コマンド or ファイル名）の下に、差分や実行結果がインラインで入る。
 *
 * shadcn には差分表示が無いので、ここは自前。Collapsible の開閉だけ同じ作法にしている。
 */

import { useState } from "react";
import { Check, ChevronRight, FileText, Terminal, X } from "lucide-react";
import type { ToolCard as Card } from "../../core/toolview.js";
import { cn } from "../lib/utils.js";

export interface ToolCardProps {
  card: Card;
  /** 実行結果。未着なら undefined = 実行中。 */
  result?: { isError: boolean; output?: { lines: string[]; truncated: boolean; omitted: number } };
}

export function ToolCardView({ card, result }: ToolCardProps) {
  const hasBody =
    (card.kind === "diff" && !!card.lines?.length) || !!result?.output?.lines.length;
  const [open, setOpen] = useState(true);

  const Icon = card.kind === "command" ? Terminal : FileText;

  return (
    <div
      className={cn(
        "my-2 overflow-hidden rounded-md border border-border bg-muted/40",
        result?.isError && "border-destructive/50",
      )}
    >
      <button
        type="button"
        disabled={!hasBody}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px]",
          hasBody && "cursor-pointer hover:bg-accent",
          open && hasBody && "border-b border-border",
        )}
      >
        {hasBody ? (
          <ChevronRight
            className={cn("h-3 w-3 shrink-0 opacity-60 transition-transform", open && "rotate-90")}
          />
        ) : (
          <Icon className="h-3 w-3 shrink-0 opacity-60" />
        )}

        <span className="min-w-0 flex-1 truncate font-mono" title={card.subtitle}>
          {card.title}
        </span>

        {card.kind === "diff" && (
          <span className="shrink-0 font-mono text-[10.5px]">
            <span className="text-add">+{card.added ?? 0}</span>{" "}
            <span className="text-del">-{card.removed ?? 0}</span>
          </span>
        )}

        <span className="shrink-0">
          {result === undefined ? (
            <span className="text-[10px] text-muted-foreground">···</span>
          ) : result.isError ? (
            <X className="h-3 w-3 text-destructive" />
          ) : (
            <Check className="h-3 w-3 text-add" />
          )}
        </span>
      </button>

      {open && hasBody && (
        <div className="overflow-x-auto font-mono text-[11.5px] leading-[1.55]">
          {card.kind === "diff" &&
            card.lines?.map((l, i) => (
              <div
                key={i}
                className={cn(
                  "whitespace-pre px-2.5",
                  l.kind === "add" && "bg-add/15",
                  l.kind === "del" && "bg-del/15",
                  l.kind === "same" && "text-muted-foreground",
                )}
              >
                {l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  "}
                {l.text}
              </div>
            ))}

          {card.truncated && (
            <div className="px-2.5 py-0.5 text-[10.5px] italic text-muted-foreground">
              … 以下省略
            </div>
          )}

          {result?.output && (
            <>
              {result.output.lines.map((line, i) => (
                <div key={i} className="whitespace-pre px-2.5 text-foreground/75">
                  {line}
                </div>
              ))}
              {/* 先頭だけ出しているので、省略は末尾に置く */}
              {result.output.truncated && (
                <div className="px-2.5 py-0.5 text-[10.5px] italic text-muted-foreground">
                  … 他 {result.output.omitted} 行
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
