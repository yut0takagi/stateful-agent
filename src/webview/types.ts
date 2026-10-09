/**
 * 拡張 ⇄ Webview のメッセージ契約。
 *
 * 両側から import されるので、ここが唯一の正。
 * 片方だけ直すとメッセージが黙って無視されるので、必ずこの型を経由する。
 */

import type { ToolCard } from "../core/toolview.js";
import type { UiElement, UiPane } from "../core/modui.js";

export type HistoryMode = "stateless" | "recent" | "full";

export interface StateRow {
  key?: string;
  value: string;
  sub?: boolean;
}

/** 拡張 → Webview */
export type HostMessage =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; tool: string; card: ToolCard }
  | { type: "toolResult"; id: string; isError: boolean; output?: { lines: string[]; truncated: boolean; omitted: number } }
  | { type: "rule"; mark?: string; text: string; level?: "warn" | "err" }
  | { type: "meta"; text: string }
  | { type: "state"; rows: StateRow[] }
  | { type: "editing"; text: string }
  | { type: "editError"; text: string }
  | { type: "rules"; count: number }
  | { type: "mode"; mode: HistoryMode }
  | { type: "done" }
  | { type: "queued"; count: number; items: string[] }
  | { type: "userEcho"; text: string }
  /** 人の指示なしに CLI がターンを始めた（mod の $.prompt.submit など）。from は送り主、text はその本文。 */
  | { type: "turnStart"; from: string | null; text: string | null }
  // mod の画面要素。CLI が生きている間（次の指示まで）届き、止まったら modClear で消す
  | { type: "modTree"; site: "band" | "pane"; id: string; tree: UiElement | null }
  | { type: "modPanes"; panes: UiPane[]; shownId: string | null }
  | { type: "modStatus"; plugin: string; text: string | null }
  | { type: "modToast"; plugin: string; text: string; timeoutMs: number }
  | { type: "modClear" };

/** Webview → 拡張 */
export type ClientMessage =
  | { type: "send"; text: string }
  | { type: "mode"; mode: HistoryMode }
  | { type: "edit" }
  | { type: "save"; text: string }
  | { type: "reset" }
  | { type: "stop" }
  /** 人が mod のボタンを押した。これ以外の経路で ui_press を送らない。 */
  | { type: "modPress"; plugin: string; handle: number; key?: string };
