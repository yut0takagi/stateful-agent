/**
 * 拡張 ⇄ Webview のメッセージ契約。
 *
 * 両側から import されるので、ここが唯一の正。
 * 片方だけ直すとメッセージが黙って無視されるので、必ずこの型を経由する。
 */

import type { ToolCard } from "../core/toolview.js";

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
  | { type: "userEcho"; text: string };

/** Webview → 拡張 */
export type ClientMessage =
  | { type: "send"; text: string }
  | { type: "mode"; mode: HistoryMode }
  | { type: "edit" }
  | { type: "save"; text: string }
  | { type: "reset" }
  | { type: "stop" };
