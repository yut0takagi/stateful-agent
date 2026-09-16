/**
 * 台帳型 state をドメインのノード集合に変換し、レイアウトする。
 *
 * ここは**組み立てだけ**を担う。
 * 「前提とは何か」「どう描かれたいか」はドメイン（domain/nodes.ts）が持ち、
 * 「どの色で描くか」は View が持つ。この層は台帳の読み取りと座標計算に専念する。
 *
 * 台帳の日本語キー（決定 / 前提 / 却下 / 検証 / 未決）を解釈するのは
 * ここと domain/nodes.ts の nodeFromLedger だけ。
 */

import {
  Decision,
  OpenQuestion,
  Premise,
  RejectedOption,
  Verification,
  normalizeDecisionState,
  type StateNode,
} from "../domain/nodes.js";
import type { AgentState } from "./state.js";

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
}

export interface Graph {
  nodes: StateNode[];
  edges: GraphEdge[];
  /**
   * 親の決定に層を追随させるノードの対。
   *
   * 却下案・検証は「その決定の結果」なので、決定の右隣に置きたい。
   * 決定の層は依存の深さで動くため、対応を持っておいて後で解決する。
   */
  followers?: Array<[Decision, RejectedOption | Verification]>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 値を表示用の文字列にする。空なら null。 */
function text(v: unknown): string | null {
  if (typeof v === "string") {
    return v.trim() === "" ? null : v.trim();
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return null;
}

/** 台帳の値は配列でも単一文字列でも来る（モデルが揺れるので寛容にする）。 */
function toList(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(text).filter((x): x is string => x !== null);
  }
  const single = text(v);
  return single === null ? [] : [single];
}

/**
 * state からグラフを組み立てる。
 *
 * エッジの向きと述語は**ノードに聞く**（canPrecede / predicateTo）。
 * ここで「前提なら決定へ」と分岐すると、接続規則が再びこの層に漏れる。
 */
export function buildGraph(state: AgentState): Graph {
  const nodes: StateNode[] = [];
  const edges: GraphEdge[] = [];

  /** 同じラベルの前提は1ノードに畳む。共有が見えることがグラフの目的。 */
  const premises = new Map<string, Premise>();
  /** 台帳 id → 決定。依存の参照を解決するための索引。 */
  const byLedgerId = new Map<string, Decision>();
  /** 依存エッジは全決定を読み終えてから張る（前方参照があるため）。 */
  const decisionNodes: Decision[] = [];
  /** 親の決定に層を追随させるノードの対。 */
  const followers: Array<[Decision, RejectedOption | Verification]> = [];
  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}${++seq}`;

  const sharePremise = (label: string): Premise => {
    const existing = premises.get(label);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Premise(nextId("p"), label);
    premises.set(label, created);
    nodes.push(created);
    return created;
  };

  /** 接続をノードに確認してからエッジにする。 */
  const connect = (from: StateNode, to: StateNode): void => {
    const predicate = from.predicateTo(to);
    if (predicate === null) {
      return;
    }
    edges.push({ from: from.id, to: to.id, label: predicate });
  };

  const decisions = state["決定"];
  if (Array.isArray(decisions)) {
    for (const raw of decisions) {
      if (!isRecord(raw)) {
        continue;
      }
      const label = text(raw["何を"]);
      if (label === null) {
        continue;
      }
      const decision = new Decision(
        nextId("d"),
        label,
        normalizeDecisionState(raw["状態"]),
        text(raw["行動"]) ?? undefined,
        text(raw["id"]) ?? undefined,
        toList(raw["依存"]),
      );
      nodes.push(decision);
      decisionNodes.push(decision);
      const ledgerId = decision.ledgerId;
      if (ledgerId !== undefined) {
        byLedgerId.set(ledgerId, decision);
      }

      for (const premiseLabel of toList(raw["前提"])) {
        connect(sharePremise(premiseLabel), decision);
      }
      for (const rejectedLabel of toList(raw["却下"])) {
        const rejected = new RejectedOption(nextId("r"), rejectedLabel);
        nodes.push(rejected);
        connect(decision, rejected);
        // 親の決定が依存で右にずれたら追随させる（レイアウト時に解決する）
        followers.push([decision, rejected]);
      }
      for (const verificationLabel of toList(raw["検証"])) {
        const verification = new Verification(nextId("v"), verificationLabel);
        nodes.push(verification);
        connect(decision, verification);
        followers.push([decision, verification]);
      }
    }
  }

  // 依存エッジは全決定を読んだ後に張る。
  // 台帳の並び順に関係なく参照できるようにするため（前方参照を許す）。
  for (const decision of decisionNodes) {
    for (const dependencyId of decision.dependsOn) {
      const source = byLedgerId.get(dependencyId);
      // 存在しない id は無視する。モデルが書き間違えても線を捏造しない。
      if (source !== undefined && source !== decision) {
        connect(source, decision);
      }
    }
  }

  const open = state["未決"];
  if (Array.isArray(open)) {
    for (const raw of open) {
      const label = isRecord(raw) ? text(raw["論点"]) : text(raw);
      if (label === null) {
        continue;
      }
      nodes.push(
        new OpenQuestion(
          nextId("o"),
          label,
          isRecord(raw) ? (text(raw["要る情報"]) ?? undefined) : undefined,
        ),
      );
    }
  }

  return { nodes, edges, followers };
}

// ---- レイアウト ----

/** 決定の最初の層。前提(0)の右隣から始まる。 */
const BASE_DECISION_LAYER = 1;

const COLUMN_WIDTH = 220;
const ROW_HEIGHT = 78;
const MARGIN = 28;

/** 座標を与えられたノード。ノード本体は差し替えずに包む。 */
export interface LaidOutNode {
  node: StateNode;
  x: number;
  y: number;
}

export interface GraphLayout {
  nodes: LaidOutNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

/**
 * 層状にレイアウトする。列はノードの layer が決める。
 *
 * 力学モデルは使わない。毎ターン state が変わるので、
 * 同じ state なら同じ絵になる決定的な配置にする
 * （力学モデルだと収束位置が揺れて「前と何が変わったか」が読めない）。
 */
export function layoutGraph(graph: Graph): GraphLayout {
  assignDecisionDepth(graph);

  const rowCount = new Map<number, number>();
  const nodes: LaidOutNode[] = graph.nodes.map((node) => {
    const col = node.layer;
    const row = rowCount.get(col) ?? 0;
    rowCount.set(col, row + 1);
    return {
      node,
      x: MARGIN + col * COLUMN_WIDTH,
      y: MARGIN + row * ROW_HEIGHT,
    };
  });

  const maxRow = Math.max(0, ...[...rowCount.values()]);
  const maxCol = Math.max(0, ...[...rowCount.keys()]);

  return {
    nodes,
    edges: graph.edges,
    width: MARGIN * 2 + (maxCol + 1) * COLUMN_WIDTH,
    height: MARGIN * 2 + Math.max(1, maxRow) * ROW_HEIGHT,
  };
}

// ---- 描画モデルへの変換 ----

/**
 * Webview へ送るノード。
 *
 * postMessage は構造化クローンなので、Class インスタンスは
 * **メソッドを失って渡る**（instanceof も効かない）。
 * そのためドメイン層は拡張プロセス側に留め、Webview へは
 * 「訳し終えた描画指示」だけを送る。
 *
 * 結果としてドメインが表現層のプロセスに漏れない — DDD としても正しい向きになる。
 * ここでも色値は持たない。`role` と `emphasis` から色を決めるのは View の責務。
 */
export interface RenderNode {
  id: string;
  label: string;
  /** 議論上の役割。View は色を決めるのにこれを使う。 */
  role: string;
  /** 表示用の分類名（前提 / 決定 / …）。 */
  kindLabel: string;
  /** 決定の確度など、分類名に添える文字。 */
  badge?: string;
  /** ツールチップ用の補足。 */
  detail?: string;
  emphasis: "central" | "supporting";
  contour: "solid" | "tentative";
  invalidated: boolean;
  x: number;
  y: number;
}

export interface RenderModel {
  nodes: RenderNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

/** レイアウト済みのドメインノードを、転送できる描画モデルに訳す。 */
export function toRenderModel(layout: GraphLayout): RenderModel {
  return {
    nodes: layout.nodes.map(({ node, x, y }) => {
      const visual = node.visual;
      return {
        id: node.id,
        label: node.label,
        role: node.role,
        kindLabel: node.kindLabel,
        ...(node instanceof Decision ? { badge: node.decisionState } : {}),
        ...(detailOf(node) !== undefined ? { detail: detailOf(node) } : {}),
        emphasis: visual.emphasis,
        contour: visual.contour,
        invalidated: visual.invalidated,
        x,
        y,
      };
    }),
    edges: layout.edges,
    width: layout.width,
    height: layout.height,
  };
}

/** ノードごとの補足情報。どのノードが何を補足に出すかはここで決める。 */
function detailOf(node: StateNode): string | undefined {
  if (node instanceof Decision) {
    return node.action;
  }
  if (node instanceof OpenQuestion) {
    return node.needs;
  }
  return undefined;
}

/**
 * 決定の層を依存の深さで決める。
 *
 * 「過去の決定が次の決定の前提になる」連鎖を横方向に見せたい。
 * 依存されている決定を左に、依存する決定を右に置くことで、
 * 左から右へ議論が進んだ順に読める。
 *
 * 循環依存があっても止まらないよう、訪問済みを辿って打ち切る
 * （モデルが誤って相互依存を書くことはある。絵が壊れるより描ける方を選ぶ）。
 */
function assignDecisionDepth(graph: Graph): void {
  const decisions = graph.nodes.filter((n): n is Decision => n instanceof Decision);
  if (decisions.length === 0) {
    return;
  }

  const byId = new Map(decisions.map((d) => [d.ledgerId ?? d.id, d]));
  const depthCache = new Map<string, number>();

  const depthOf = (decision: Decision, visiting: Set<string>): number => {
    const key = decision.id;
    const cached = depthCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    // 循環に入ったら最小の深さで打ち切る。
    if (visiting.has(key)) {
      return BASE_DECISION_LAYER;
    }
    visiting.add(key);

    let depth = BASE_DECISION_LAYER;
    for (const dependencyId of decision.dependsOn) {
      const source = byId.get(dependencyId);
      if (source !== undefined && source !== decision) {
        depth = Math.max(depth, depthOf(source, visiting) + 1);
      }
    }

    visiting.delete(key);
    depthCache.set(key, depth);
    return depth;
  };

  for (const decision of decisions) {
    decision.setDepth(depthOf(decision, new Set()));
  }

  // 却下案・検証を親の決定の右隣へ動かす。
  for (const [parent, follower] of graph.followers ?? []) {
    follower.setDepth(parent.layer + 1);
  }
}

// ---- 表示幅の調整 ----

/** 全角1文字を 1 単位、半角を 0.5 単位として数えたときの文字幅。 */
function widthOf(char: string): number {
  // 半角英数・記号・半角カナは半分の幅。それ以外（日本語・全角記号）は1単位。
  return /[ -~｡-ﾟ]/.test(char) ? 0.5 : 1;
}

/**
 * 表示幅で文字列を切る。
 *
 * 文字数で切ると日本語がはみ出す。全角は半角の約2倍の幅があるので、
 * 22文字の日本語は 168px の枠に収まらない（実際にはみ出していた）。
 *
 * maxWidth は「全角何文字ぶんか」で指定する。
 */
export function clipToWidth(text: string, maxWidth: number): string {
  if (text === "") {
    return "";
  }

  let width = 0;
  for (const char of text) {
    width += widthOf(char);
  }
  if (width <= maxWidth) {
    return text;
  }

  // 省略記号のぶんを空けて詰める。
  const budget = maxWidth - 1;
  let used = 0;
  let out = "";
  for (const char of text) {
    const w = widthOf(char);
    if (used + w > budget) {
      break;
    }
    out += char;
    used += w;
  }
  return out + "…";
}
