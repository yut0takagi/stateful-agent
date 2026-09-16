/**
 * state インスペクタ。
 *
 * 表示と手編集。編集中にモデルが state を書き換えても、編集内容は上書きしない
 * （打っている途中で消えるのが一番困る）。
 */

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import type { StateRow } from "../types.js";
import { cn } from "../lib/utils.js";

export interface StatePanelProps {
  rows: StateRow[];
  editing: { text: string; error?: string } | null;
  onEdit(): void;
  onSave(text: string): void;
  onCancel(): void;
}

export function StatePanel({ rows, editing, onEdit, onSave, onCancel }: StatePanelProps) {
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (editing) setDraft(editing.text);
  }, [editing?.text]);

  return (
    <div className="mx-3 mt-3 max-h-[26vh] overflow-y-auto rounded-md bg-muted px-3 py-2.5 text-[12px] leading-relaxed">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="mr-auto text-[10px] uppercase tracking-wider text-muted-foreground">
          state
        </span>
        {editing ? (
          <>
            <button
              type="button"
              onClick={() => onSave(draft)}
              className="rounded px-1.5 py-0.5 text-[10.5px] text-[var(--vscode-textLink-foreground)] hover:bg-accent"
            >
              保存
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-accent"
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onEdit}
            title="state を手で直す"
            className="rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>

      {editing ? (
        <>
          <textarea
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSave(draft);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
            className="min-h-[120px] w-full resize-y rounded border border-border bg-input px-2 py-1.5 font-mono text-[12px] outline-none focus:border-ring"
          />
          {editing.error && (
            <div className="pt-1 text-[11px] text-destructive">{editing.error}</div>
          )}
        </>
      ) : rows.length === 0 ? (
        <div className="italic text-muted-foreground">state は空</div>
      ) : (
        rows.map((r, i) => (
          <div key={i} className={cn("flex gap-2 py-px", r.sub && "pl-3")}>
            {r.key && <span className="shrink-0 text-muted-foreground">{r.key}</span>}
            <span className="min-w-0 flex-1 break-words">{r.value}</span>
          </div>
        ))
      )}
    </div>
  );
}
