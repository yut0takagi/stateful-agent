/**
 * 決定の台帳（state の「決定」「未決」）を、プロンプトに載る量が増え続けないように扱う。
 *
 * state は追記されるだけで減らなかった（reports/bench-state-growth.html: 12 ターンで 3.7KB → 40KB、
 * 大半が決定）。グラフ（決定がノード、依存が辺）は崩さずに、次の 2 つで載る量を抑える。
 *
 * 1. 段階表示: 詳しく載せるのは上限（limits.detail）まで。判断モデルが今回の指示に関係すると見た決定、
 *    直近の決定、それらが依存する決定、暫定の決定の順に選ぶ。残りは「D3 [確定] 何を」の 1 行にする。
 *    1 行でも id が見えるので、依存にはその id を書ける
 * 2. 退避: current.json の決定が上限（limits.keep）を超えたら、古い確定・撤回から archive.jsonl に移す。
 *    足りなければ古い暫定も移す。詳しく載せる決定は移さない。解決した未決はすぐ移す。
 *    グラフは current と archive を合わせて全件を描く
 *
 * 上限がないと有界にならない。実物の state では暫定が多く（devtch: 17 件中 7 件）、
 * 「暫定と、その依存は全部詳しく」だとほぼ全件が詳しく載った
 *
 * VS Code にもファイルにも依存しない。読み書きは呼び出し側が行う。
 */

import type { AgentState } from "./state.js";

type Rec = Record<string, unknown>;

/** 退避した 1 件。archive.jsonl の 1 行。 */
export interface ArchiveEntry {
  kind: "決定" | "未決";
  item: Rec;
  archivedAt: string;
}

export interface LedgerLimits {
  /** current.json に残す決定の数。超えたら古い確定・撤回から退避する。 */
  keep: number;
  /** 状態によらず詳しく載せる、直近の決定の数。 */
  recent: number;
  /** 詳しく載せる決定の上限。 */
  detail: number;
  /** 「要る情報」まで載せる未決の数（新しいものから）。古いものは「id 論点」の 1 行にする。 */
  openDetail: number;
}

export const DEFAULT_LEDGER_LIMITS: LedgerLimits = { keep: 12, recent: 4, detail: 6, openDetail: 8 };

/** 退避した id を覚えておく制御キー。プロンプトには載せない。新しい id が退避分と重ならないようにするため。 */
export const ARCHIVED_IDS_KEY = "archived_ids";

/** 退避ファイルの場所。プロンプトでモデルに知らせる。 */
export const ARCHIVE_FILE = ".ctx/state/archive.jsonl";

/** 解決した未決とみなす状態。 */
const RESOLVED = new Set(["解決", "解決済み", "不要", "取り下げ"]);
/** 退避してよい決定の状態。暫定は覆す余地があるので残す。 */
const SETTLED = new Set(["確定", "撤回"]);
/** 詳しく書くときの、決定の項目の並び。ほかの項目もあれば後ろに続ける。 */
const DETAIL_FIELDS = ["前提", "却下", "行動", "検証"];
const HEAD_FIELDS = new Set(["id", "何を", "状態", "依存", ...DETAIL_FIELDS]);

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : str(v) !== null ? [str(v)!] : [];

/** 値を 1 行の文字にする。配列は「、」でつなぎ、オブジェクトは JSON にする。 */
function plain(v: unknown): string {
  if (Array.isArray(v)) {
    return v.map(plain).join("、");
  }
  if (isRec(v)) {
    return JSON.stringify(v);
  }
  return String(v);
}

export function idOf(item: unknown): string | null {
  return isRec(item) ? str(item.id) : null;
}

export function decisionsOf(state: AgentState): Rec[] {
  const v = state["決定"];
  return Array.isArray(v) ? v.filter(isRec) : [];
}

export function archivedIdsOf(state: AgentState): string[] {
  const v = state[ARCHIVED_IDS_KEY];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ---------- 1 行の要約 ----------

/** 決定を 1 行にする。「D3 [確定] 何を」。 */
export function summarizeDecision(d: Rec): string {
  const what = str(d["何を"]) ?? "（何を が空）";
  return [str(d.id), str(d["状態"]) ? `[${str(d["状態"])}]` : null, what].filter((x) => x !== null).join(" ");
}

/** 未決を 1 行にする。「Q2 論点（要る情報: …）」。 */
export function summarizeOpen(q: Rec): string {
  const topic = str(q["論点"]) ?? plain(q);
  const need = str(q["要る情報"]);
  return [str(q.id), topic].filter((x) => x !== null).join(" ") + (need ? `（要る情報: ${need}）` : "");
}

/** state の配列の要素を 1 行にする。決定・未決以外のオブジェクトは「キー: 値」を並べる。 */
export function summarizeItem(key: string, item: unknown): string {
  if (!isRec(item)) {
    return String(item);
  }
  if (key === "決定") {
    return summarizeDecision(item);
  }
  if (key === "未決") {
    return summarizeOpen(item);
  }
  return Object.entries(item)
    .map(([k, v]) => `${k}: ${plain(v)}`)
    .join(" / ");
}

// ---------- 段階表示 ----------

/**
 * 詳しく載せる決定を選ぶ。返すのは decisions の添字で、max 件まで。
 *
 * 優先順: focus に名指しされたもの → 直近 recent 件（新しい順）→ それらが依存する決定 →
 * 暫定（新しい順）→ その依存。依存をたどるのは、いま動いている判断の根拠を、
 * 引き継いだ側が読めるようにするため。たどるのは 1 段だけ。
 */
export function selectDetailed(
  decisions: Rec[],
  recent: number,
  focus: Iterable<string> = [],
  max = Number.POSITIVE_INFINITY,
): Set<number> {
  const byId = new Map<string, number>();
  decisions.forEach((d, i) => {
    const id = str(d.id);
    if (id !== null) {
      byId.set(id, i);
    }
  });
  const order: number[] = [];
  const add = (i: number | undefined) => {
    if (i !== undefined && !order.includes(i)) {
      order.push(i);
    }
  };
  const addDeps = (seeds: number[]) => {
    for (const i of seeds) {
      for (const dep of list(decisions[i]!["依存"])) {
        add(byId.get(dep));
      }
    }
  };

  for (const id of focus) {
    add(byId.get(id));
  }
  for (let i = decisions.length - 1; i >= Math.max(0, decisions.length - recent); i--) {
    add(i);
  }
  addDeps([...order]);
  const provisional: number[] = [];
  for (let i = decisions.length - 1; i >= 0; i--) {
    if (str(decisions[i]!["状態"]) === "暫定") {
      provisional.push(i);
      add(i);
    }
  }
  addDeps(provisional);
  return new Set(order.slice(0, max));
}

/** 決定を詳しく書く。Markdown の入れ子の箇条書き。 */
function detailLines(d: Rec): string[] {
  const deps = list(d["依存"]);
  const lines = [`    - ${summarizeDecision(d)}${deps.length > 0 ? `（依存: ${deps.join(", ")}）` : ""}`];
  for (const field of DETAIL_FIELDS) {
    const values = list(d[field]);
    if (values.length > 0) {
      lines.push(`        - ${field}: ${values.join(" / ")}`);
    }
  }
  for (const [k, v] of Object.entries(d)) {
    if (!HEAD_FIELDS.has(k) && v !== null && v !== undefined && v !== "") {
      lines.push(`        - ${k}: ${plain(v)}`);
    }
  }
  return lines;
}

export interface DecisionView {
  recent: number;
  /** 詳しく載せる決定の上限。 */
  detail: number;
  /** 詳しく載せる決定の id（判断モデルが今回の指示に関係すると見たもの）。 */
  focus?: Iterable<string>;
  /** 退避した決定のうち、今回の指示に関係するもの。詳しく載せる。 */
  recalled?: Rec[];
  /** 退避した決定の数。 */
  archivedCount: number;
  /** 次に振る決定の id。 */
  nextId: string;
}

/**
 * プロンプトの「決定」の節。台帳の順に並べ、詳しく載せないものは 1 行にする。
 * 決定が 1 件もなく、退避もしていなければ空。
 */
export function renderDecisions(decisions: Rec[], view: DecisionView): string[] {
  const recalled = view.recalled ?? [];
  if (decisions.length === 0 && recalled.length === 0 && view.archivedCount === 0) {
    return [];
  }
  const detailed = selectDetailed(decisions, view.recent, view.focus, view.detail);
  const lines = ["- **決定**:"];
  decisions.forEach((d, i) => {
    if (detailed.has(i)) {
      lines.push(...detailLines(d));
    } else {
      lines.push(`    - ${summarizeDecision(d)}`);
    }
  });
  if (recalled.length > 0) {
    lines.push("    - 退避した決定のうち、今回の指示に関係するもの:");
    for (const d of recalled) {
      lines.push(...detailLines(d).map((l) => "    " + l));
    }
  }
  const note = [
    "1 行の決定も有効。依存にはその id を書いてよい",
    view.archivedCount > 0 ? `ほかに ${view.archivedCount} 件を ${ARCHIVE_FILE} に退避した（グラフには残っている）` : null,
    `新しい決定の id は ${view.nextId} から振る`,
  ].filter((x) => x !== null);
  lines.push(`    - （${note.join("。")}）`);
  return lines;
}

/** プロンプトの「未決」の節。新しい max 件は「要る情報」まで、古いものは「id 論点」の 1 行。 */
export function renderOpen(items: unknown[], max: number): string[] {
  if (items.length === 0) {
    return [];
  }
  const cut = Math.max(0, items.length - max);
  return [
    "- **未決**:",
    ...items.map((q, i) => {
      if (!isRec(q)) {
        return `    - ${String(q)}`;
      }
      return `    - ${i < cut ? [str(q.id), str(q["論点"]) ?? plain(q)].filter((x) => x !== null).join(" ") : summarizeOpen(q)}`;
    }),
  ];
}

// ---------- id ----------

/** 次に振る決定の id。current と退避分の「D 数字」の最大の次。 */
export function nextDecisionId(state: AgentState): string {
  let max = 0;
  for (const id of [...decisionsOf(state).map((d) => str(d.id)), ...archivedIdsOf(state)]) {
    const m = id === null ? null : /^D(\d+)$/.exec(id);
    if (m) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return `D${max + 1}`;
}

/** id のない未決に「Q 数字」を振る。taken は使用済みの id（退避分を含む）。 */
export function assignOpenIds(items: unknown[], taken: Iterable<string>): unknown[] {
  const used = new Set(taken);
  for (const item of items) {
    const id = idOf(item);
    if (id !== null) {
      used.add(id);
    }
  }
  let max = 0;
  for (const id of used) {
    const m = /^Q(\d+)$/.exec(id);
    if (m) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return items.map((item) => (isRec(item) && idOf(item) === null ? { id: `Q${++max}`, ...item } : item));
}

// ---------- 退避 ----------

/**
 * 退避する。返すのは、退避したあとの state と、archive.jsonl に足す行。
 *
 * - 解決した未決（状態が「解決」など）はすぐ移す
 * - 決定が limits.keep 件を超えたら、古い順に、確定・撤回で、詳しく載せる決定から依存されていないものを移す
 */
export function planArchive(
  state: AgentState,
  limits: LedgerLimits,
  now: Date,
): { state: AgentState; archived: ArchiveEntry[] } {
  const at = now.toISOString();
  const archived: ArchiveEntry[] = [];

  const open = Array.isArray(state["未決"]) ? (state["未決"] as unknown[]) : null;
  const keptOpen = open?.filter((q) => {
    if (isRec(q) && RESOLVED.has(str(q["状態"]) ?? "")) {
      archived.push({ kind: "未決", item: q, archivedAt: at });
      return false;
    }
    return true;
  });

  const all = Array.isArray(state["決定"]) ? (state["決定"] as unknown[]) : null;
  let keptDecisions = all;
  if (all !== null) {
    const records = all.filter(isRec);
    if (records.length > limits.keep) {
      // 詳しく載せる決定（直近・その依存・新しい暫定）は移さない
      const protectedIdx = selectDetailed(records, limits.recent, [], limits.detail);
      let excess = records.length - limits.keep;
      const moved = new Set<Rec>();
      // 古い確定・撤回から移し、足りなければ古い暫定も移す（グラフには残る）
      for (const pass of [(st: string) => SETTLED.has(st), (st: string) => !SETTLED.has(st)]) {
        records.forEach((d, i) => {
          if (excess > 0 && !moved.has(d) && !protectedIdx.has(i) && pass(str(d["状態"]) ?? "")) {
            moved.add(d);
            excess -= 1;
          }
        });
      }
      keptDecisions = all.filter((d) => !(isRec(d) && moved.has(d)));
      for (const d of moved) {
        archived.push({ kind: "決定", item: d, archivedAt: at });
      }
    }
  }

  if (archived.length === 0) {
    return { state, archived };
  }
  const ids = archived.map((e) => idOf(e.item)).filter((x): x is string => x !== null);
  const next: AgentState = { ...state, [ARCHIVED_IDS_KEY]: [...archivedIdsOf(state), ...ids] };
  if (keptOpen !== undefined) {
    next["未決"] = keptOpen;
  }
  if (keptDecisions !== null) {
    next["決定"] = keptDecisions;
  }
  return { state: next, archived };
}

/** archive.jsonl の中身を読む。壊れた行は飛ばす。 */
export function parseArchive(raw: string): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const e = JSON.parse(line) as Partial<ArchiveEntry>;
      if ((e.kind === "決定" || e.kind === "未決") && isRec(e.item)) {
        out.push({ kind: e.kind, item: e.item, archivedAt: typeof e.archivedAt === "string" ? e.archivedAt : "" });
      }
    } catch {
      // 読めない行は捨てる。1 行の破損で全件を失わないように
    }
  }
  return out;
}

export function formatArchive(entries: ArchiveEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
}

/** 退避した決定（新しいものが後ろ）。同じ id が複数あれば後のものを残す。 */
export function archivedDecisions(entries: ArchiveEntry[]): Rec[] {
  const byId = new Map<string, Rec>();
  const noId: Rec[] = [];
  for (const e of entries) {
    if (e.kind !== "決定") {
      continue;
    }
    const id = idOf(e.item);
    if (id === null) {
      noId.push(e.item);
    } else {
      byId.delete(id);
      byId.set(id, e.item);
    }
  }
  return [...noId, ...byId.values()];
}

/**
 * グラフ用に、退避した決定を current の前に足す。グラフは全件を描く。
 * 退避後に current で書き直された id は current を正とする。
 */
export function withArchived(state: AgentState, entries: ArchiveEntry[]): AgentState {
  const old = archivedDecisions(entries);
  if (old.length === 0) {
    return state;
  }
  const current = decisionsOf(state);
  const live = new Set(current.map((d) => str(d.id)).filter((x): x is string => x !== null));
  return { ...state, 決定: [...old.filter((d) => !live.has(str(d.id) ?? "")), ...current] };
}
