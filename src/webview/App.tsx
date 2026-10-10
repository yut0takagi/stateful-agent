/**
 * Webview のルート。
 *
 * 拡張から届くメッセージを1本のタイムラインに積む。
 * テキストとツールカードが時系列で混ざるので、配列に順番どおり入れて描く
 * （Claude Code for VSCode と同じ見え方になる）。
 */

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { ChatMessage, TypingIndicator } from "./ui/message.js";
import { MarkdownRenderer } from "./ui/markdown.js";
import { ToolCardView } from "./ui/tool-card.js";
import { StatePanel } from "./ui/state-panel.js";
import { Composer } from "./ui/composer.js";
import { ModSurfaceView, type ModPaneView } from "./ui/mod-surface.js";
import type { ToolCard } from "../core/toolview.js";
import type { UiElement } from "../core/modui.js";
import type { ClientMessage, HistoryMode, HostMessage, StateRow } from "./types.js";
import { cn } from "./lib/utils.js";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = acquireVsCodeApi();
const send = (m: ClientMessage): void => vscode.postMessage(m);

/** タイムラインの1項目。 */
type Item =
  | { kind: "msg"; id: number; isUser: boolean; text: string; streaming: boolean }
  | { kind: "tool"; id: string; card: ToolCard; result?: { isError: boolean; output?: { lines: string[]; truncated: boolean; omitted: number } } }
  | { kind: "note"; id: number; mark: string; text: string; level?: "warn" | "err" }
  /** 人の指示なしに CLI が始めたターン。送り主と、積まれたプロンプトの本文（Markdown）。 */
  | { kind: "turn"; id: number; from: string | null; text: string | null };

let seq = 0;

export function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [rows, setRows] = useState<StateRow[]>([]);
  const [editing, setEditing] = useState<{ text: string; error?: string } | null>(null);
  const [ruleCount, setRuleCount] = useState<number | null>(null);
  const [mode, setMode] = useState<HistoryMode>("recent");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [queuedItems, setQueuedItems] = useState<string[]>([]);

  // mod の画面要素。CLI が生きている間（次の指示まで）描き、modClear で消す
  const [modBand, setModBand] = useState<UiElement | null>(null);
  const [modPanes, setModPanes] = useState<ModPaneView[]>([]);
  const [modShownId, setModShownId] = useState<string | null>(null);
  const [modStatus, setModStatus] = useState<Record<string, string>>({});
  const [modToasts, setModToasts] = useState<Array<{ id: number; plugin: string; text: string }>>([]);

  // done ハンドラは初回の値を掴んだままなので、最新の待機件数は ref で見る
  const queuedRef = useRef(0);
  useEffect(() => {
    queuedRef.current = queuedItems.length;
  }, [queuedItems]);

  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // 下端に居るときだけ追従する（読み返している最中に飛ばさない）
  const onScroll = (): void => {
    const el = logRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent<HostMessage>): void => {
      const m = ev.data;

      if (m.type === "text") {
        setItems((prev) => {
          const last = prev[prev.length - 1];
          // 直前が同じ応答ならそこに足す。ツールを挟んだ後は新しい吹き出しにする。
          if (last?.kind === "msg" && !last.isUser && last.streaming) {
            return [...prev.slice(0, -1), { ...last, text: last.text + m.text }];
          }
          return [
            ...prev,
            { kind: "msg", id: ++seq, isUser: false, text: m.text, streaming: true },
          ];
        });
      }

      if (m.type === "tool") {
        // ツールが割り込んだら、走っていた吹き出しは確定させる
        setItems((prev) => [
          ...prev.map((i) => (i.kind === "msg" && i.streaming ? { ...i, streaming: false } : i)),
          { kind: "tool", id: m.id, card: m.card },
        ]);
      }

      if (m.type === "toolResult") {
        setItems((prev) =>
          prev.map((i) =>
            i.kind === "tool" && i.id === m.id
              ? { ...i, result: { isError: m.isError, output: m.output } }
              : i,
          ),
        );
      }

      if (m.type === "rule") {
        setItems((prev) => [
          ...prev,
          { kind: "note", id: ++seq, mark: m.mark ?? "•", text: m.text, level: m.level },
        ]);
      }
      if (m.type === "meta") {
        setItems((prev) => [...prev, { kind: "note", id: ++seq, mark: "", text: m.text }]);
      }

      if (m.type === "state") {
        setRows(m.rows);
        // 編集中なら閉じない。打っている内容を守る。
        setEditing((e) => e);
      }
      if (m.type === "editing") setEditing({ text: m.text });
      if (m.type === "editError") setEditing((e) => (e ? { ...e, error: m.text } : e));
      if (m.type === "rules") setRuleCount(m.count);
      if (m.type === "mode") setMode(m.mode);

      if (m.type === "queued") setQueuedItems(m.items);
      // キューから実行された指示を、自分が打ったものとして並べる
      if (m.type === "userEcho") {
        setItems((prev) => [
          ...prev,
          { kind: "msg", id: ++seq, isUser: true, text: m.text, streaming: false },
        ]);
      }

      // 人が送っていないターン。誰が何を頼んだかを残し、走っている間は送った指示を待たせる
      if (m.type === "turnStart") {
        setItems((prev) => [...prev, { kind: "turn", id: ++seq, from: m.from, text: m.text }]);
        setBusy(true);
      }

      if (m.type === "modTree") {
        if (m.site === "band") {
          setModBand(m.tree);
        } else {
          setModPanes((prev) => prev.map((p) => (p.id === m.id ? { ...p, tree: m.tree } : p)));
        }
      }
      if (m.type === "modPanes") {
        // 一覧は毎回全量で届く。描いてあった中身は id で引き継ぐ
        setModPanes((prev) => m.panes.map((p) => ({ ...p, tree: prev.find((q) => q.id === p.id)?.tree ?? null })));
        setModShownId(m.shownId);
      }
      if (m.type === "modStatus") {
        setModStatus((prev) => {
          const next = { ...prev };
          if (m.text === null) {
            delete next[m.plugin];
          } else {
            next[m.plugin] = m.text;
          }
          return next;
        });
      }
      if (m.type === "modToast") {
        const id = ++seq;
        setModToasts((prev) => [...prev, { id, plugin: m.plugin, text: m.text }]);
        setTimeout(() => setModToasts((prev) => prev.filter((t) => t.id !== id)), m.timeoutMs);
      }
      if (m.type === "modClear") {
        // トーストは時間で消えるので残す。帯・ペイン・ステータス行は押せる相手がもういない
        setModBand(null);
        setModPanes([]);
        setModShownId(null);
        setModStatus({});
      }

      if (m.type === "done") {
        // 待機中が残っているなら続けて走るので busy のままにする。
        setBusy((wasBusy) => (queuedRef.current > 0 ? wasBusy : false));
        setItems((prev) => prev.map((i) => (i.kind === "msg" ? { ...i, streaming: false } : i)));
      }
    };

    window.addEventListener("message", onMessage);
    // 受け取る準備ができてから初期表示を頼む。先に送られた分は捨てられる
    send({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // 打ち始めたら判断モデルを暖めてもらう。送るまでに読み込みが済むように。30 秒に 1 回まで
  const lastTyping = useRef(0);
  const onInput = (text: string): void => {
    setInput(text);
    if (text !== "" && Date.now() - lastTyping.current > 30_000) {
      lastTyping.current = Date.now();
      send({ type: "typing" });
    }
  };

  const submit = (): void => {
    const text = input.trim();
    if (!text) return;
    // 走っている最中でも投げられる。拡張側がキューに積んで順に流す。
    // 積まれた分は userEcho で戻ってくるので、ここでは自分の分だけ並べる。
    if (!busy) {
      setItems((prev) => [
        ...prev,
        { kind: "msg", id: ++seq, isUser: true, text, streaming: false },
      ]);
      setBusy(true);
    }
    send({ type: "send", text });
    setInput("");
    stick.current = true;
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="mr-auto font-semibold tracking-tight">Stateful Agent</span>

        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              ruleCount ? "bg-add" : "bg-muted-foreground",
            )}
          />
          {ruleCount === null ? "読み込み中" : `${ruleCount} 本の規律`}
        </span>

        <select
          value={mode}
          title="履歴モード"
          onChange={(e) => {
            const next = e.target.value as HistoryMode;
            setMode(next);
            send({ type: "mode", mode: next });
          }}
          className="cursor-pointer appearance-none rounded-full border border-border bg-transparent py-0.5 pl-2.5 pr-2.5 text-[11px] text-foreground outline-none hover:border-foreground/30"
        >
          <option value="stateless">履歴なし</option>
          <option value="recent">直近のみ</option>
          <option value="full">全履歴</option>
        </select>

        <button
          type="button"
          title="state をリセット"
          onClick={() => send({ type: "reset" })}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </header>

      <StatePanel
        rows={rows}
        editing={editing}
        onEdit={() => send({ type: "edit" })}
        onSave={(text) => send({ type: "save", text })}
        onCancel={() => setEditing(null)}
      />

      <div ref={logRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-3">
        {items.length === 0 && (
          <div className="text-[12px] text-muted-foreground">指示を書いて Cmd + Enter</div>
        )}

        {items.map((item) =>
          item.kind === "msg" ? (
            <ChatMessage
              key={item.id}
              content={item.text}
              isUser={item.isUser}
              streaming={item.streaming}
            />
          ) : item.kind === "tool" ? (
            <ToolCardView key={item.id} card={item.card} result={item.result} />
          ) : item.kind === "turn" ? (
            <div key={item.id} className="mb-3 text-[12px] text-muted-foreground">
              <div className="flex items-start gap-2 py-1 text-[11.5px]">
                <span className="shrink-0 opacity-85">↻</span>
                <span>{item.from ?? "CLI"} が続きのターンを始めた</span>
              </div>
              {item.text && (
                <div className="ml-5 border-l border-border pl-3">
                  <MarkdownRenderer>{item.text}</MarkdownRenderer>
                </div>
              )}
            </div>
          ) : (
            <div
              key={item.id}
              className={cn(
                "flex items-start gap-2 py-1 text-[11.5px] text-muted-foreground",
                item.level === "warn" && "text-[var(--vscode-editorWarning-foreground)]",
                item.level === "err" && "text-destructive",
              )}
            >
              <span className="shrink-0 opacity-85">{item.mark}</span>
              <span className="whitespace-pre-wrap">{item.text}</span>
            </div>
          ),
        )}

        {busy && !items.some((i) => i.kind === "msg" && i.streaming) && <TypingIndicator />}
      </div>

      <ModSurfaceView
        band={modBand}
        panes={modPanes}
        shownId={modShownId}
        status={modStatus}
        toasts={modToasts}
        onPress={(ref) => send({ type: "modPress", plugin: ref.plugin, handle: ref.handle, ...(ref.key ? { key: ref.key } : {}) })}
        onShowPane={setModShownId}
        onDismissToast={(id) => setModToasts((prev) => prev.filter((t) => t.id !== id))}
      />

      <Composer
        value={input}
        busy={busy}
        queued={queuedItems}
        onChange={onInput}
        onSubmit={submit}
        onStop={() => send({ type: "stop" })}
      />
    </div>
  );
}
