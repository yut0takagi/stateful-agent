/**
 * mod の画面要素（トースト・ステータス行・帯・ペイン・ボタン）を受け渡すための型と、
 * CLI の stdout の行の振り分け。
 *
 * 相手は CLI の stream-json にある非公開（@internal）の口で、仕様は
 * reports/mod-surface-protocol.md に実測で記録してある。版が変わると黙って変わりうるので、
 * 形を知っているのはこのファイルだけにする。
 *
 * 拡張側（modsurface.ts）と Webview 側の両方から import されるので、Node の API は使わない。
 */

/** 押せる要素が持つ印。押すときはこれをそのまま ui_press に載せる。 */
export interface UiPressRef {
  plugin: string;
  handle: number;
}

/**
 * ui_render が返す要素の木。
 *
 * `engine` は「mod は描かず CLI に任せた」の印で、遠隔の画面では何も描かない。
 * それ以外は Box・Text・Button などの要素で、children に文字列が混ざる。
 */
export interface UiElement {
  type: string;
  props?: Record<string, unknown>;
  children?: UiChild[];
  press?: UiPressRef;
}
export type UiChild = UiElement | string;

/** 画面に出ているペイン 1 つ。ui_panes が毎回全量で届く。 */
export interface UiPane {
  id: string;
  title: string;
  plugin: string;
}

/** CLI から一方的に届く通知。 */
export type UiNotice =
  | { kind: "toast"; plugin: string; text: string; timeoutMs: number }
  | { kind: "status"; plugin: string; text: string | null }
  | { kind: "log"; plugin: string; text: string }
  | { kind: "panes"; panes: UiPane[]; shownId: string | null }
  | { kind: "invalidate"; instances?: UiInstanceRef[] };

/** ui_invalidate が名指しする描画済みの部品。 */
export interface UiInstanceRef {
  surface: string;
  component: string;
  instanceId: string;
}

/** 制御要求への返答。 */
export type ControlResponse =
  | { subtype: "success"; request_id: string; response?: unknown }
  | { subtype: "error"; request_id: string; error: string };

/**
 * stdout の 1 行の行き先。
 *
 * own:      自分が送った制御要求への返答。SDK には渡さない
 * notice:   画面要素の通知。SDK にも渡す（SDK は知らない subtype を読み流す）
 * response: SDK が送った制御要求への返答。最初の 1 つが initialize の返答になる
 * other:    それ以外。そのまま SDK に渡す
 */
export type RoutedLine =
  | { kind: "own"; response: ControlResponse }
  | { kind: "notice"; notice: UiNotice }
  | { kind: "response" }
  | { kind: "other" };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 通知の形が崩れていたら null を返す。知らない形を描こうとしない。 */
export function parseNotice(m: Record<string, unknown>): UiNotice | null {
  const plugin = typeof m.plugin === "string" ? m.plugin : "";
  switch (m.subtype) {
    case "ui_toast":
      return typeof m.text === "string"
        ? { kind: "toast", plugin, text: m.text, timeoutMs: typeof m.timeout_ms === "number" ? m.timeout_ms : 4000 }
        : null;
    case "ui_status":
      return typeof m.text === "string" || m.text === null ? { kind: "status", plugin, text: m.text } : null;
    case "ui_log":
      return typeof m.text === "string" ? { kind: "log", plugin, text: m.text } : null;
    case "ui_panes": {
      if (!Array.isArray(m.panes)) {
        return null;
      }
      const panes = m.panes.flatMap((p): UiPane[] =>
        isRecord(p) && typeof p.id === "string"
          ? [{ id: p.id, title: typeof p.title === "string" ? p.title : p.id, plugin: typeof p.plugin === "string" ? p.plugin : "" }]
          : [],
      );
      return { kind: "panes", panes, shownId: typeof m.shown_id === "string" ? m.shown_id : null };
    }
    case "ui_invalidate": {
      if (!Array.isArray(m.instances)) {
        return { kind: "invalidate" };
      }
      const instances = m.instances.flatMap((i): UiInstanceRef[] =>
        isRecord(i) && typeof i.component === "string" && typeof i.instance_id === "string"
          ? [{ surface: typeof i.surface === "string" ? i.surface : "", component: i.component, instanceId: i.instance_id }]
          : [],
      );
      return { kind: "invalidate", instances };
    }
    default:
      return null;
  }
}

/**
 * stdout の 1 行を振り分ける。
 *
 * ownPrefix は自分が振る request_id の頭。SDK の request_id と衝突しない文字列にする。
 * JSON でない行は other（SDK にそのまま渡す。読めない行を握りつぶさない）。
 */
export function routeLine(line: string, ownPrefix: string): RoutedLine {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return { kind: "other" };
  }
  if (!isRecord(m)) {
    return { kind: "other" };
  }
  if (m.type === "control_response" && isRecord(m.response)) {
    const r = m.response;
    if (typeof r.request_id === "string" && r.request_id.startsWith(ownPrefix)) {
      return { kind: "own", response: r as unknown as ControlResponse };
    }
    return { kind: "response" };
  }
  if (m.type === "system" && typeof m.subtype === "string" && m.subtype.startsWith("ui_")) {
    const notice = parseNotice(m);
    return notice ? { kind: "notice", notice } : { kind: "other" };
  }
  return { kind: "other" };
}

/** ui_render の返答から木を取り出す。CLI に任せた印（engine）は null にする。 */
export function treeOf(response: unknown): UiElement | null {
  if (!isRecord(response) || !isRecord(response.tree)) {
    return null;
  }
  const tree = response.tree as unknown as UiElement;
  return tree.type === "engine" ? null : tree;
}

/**
 * mod が $.prompt.submit() で積んだプロンプトから、mod が書いた本文を取り出す。
 *
 * CLI はモデルに渡す前に、本文を次の文面で包む（2.1.295 で実測）。
 *
 *   The push-gate plugin sent a message:
 *   <本文>
 *
 *   This is how Claude Code surfaces a prompt a plugin submits between turns — …
 *
 * 文面が変わって当てはまらなければ、包みごと返す（本文を落とすより、余計に見せるほうがよい）。
 */
export function unwrapPluginPrompt(text: string): string {
  const m = /^The .+? plugin sent a message:\n([\s\S]*?)\n\nThis is how Claude Code surfaces a prompt a plugin submits/.exec(text);
  return m?.[1] ?? text;
}

/** Text の children を 1 本の文字列にする。JSX の式は文字列の配列で届き、空文字も混ざる。 */
export function textOf(children: UiChild[] | undefined): string {
  return (children ?? []).map((c) => (typeof c === "string" ? c : textOf(c.children))).join("");
}
