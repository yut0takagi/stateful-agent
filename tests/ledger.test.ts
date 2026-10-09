/**
 * 決定の台帳の段階表示と退避（ledger.ts）のテスト。
 *
 * 膨張の実測は reports/bench-state-growth.html（12 ターンで 3.7KB → 40KB、大半が決定）。
 */

import { describe, expect, it } from "vitest";
import {
  ARCHIVED_IDS_KEY,
  archivedDecisions,
  assignOpenIds,
  formatArchive,
  nextDecisionId,
  parseArchive,
  planArchive,
  renderDecisions,
  renderOpen,
  selectDetailed,
  summarizeDecision,
  summarizeItem,
  summarizeOpen,
  withArchived,
  type ArchiveEntry,
} from "../src/core/ledger.js";
import type { AgentState } from "../src/core/state.js";

const d = (n: number, 状態 = "確定", extra: Record<string, unknown> = {}) => ({
  id: `D${n}`,
  何を: `決定${n}`,
  前提: [`前提${n}`],
  行動: `行動${n}`,
  状態,
  ...extra,
});
const stateOf = (決定: unknown[], extra: Record<string, unknown> = {}): AgentState => ({
  schema_version: 1,
  active: true,
  決定,
  ...extra,
});
const NOW = new Date("2026-10-10T00:00:00Z");

describe("1 行の要約", () => {
  it("決定は「id [状態] 何を」", () => {
    expect(summarizeDecision(d(3))).toBe("D3 [確定] 決定3");
    expect(summarizeDecision({ 何を: "id なし" })).toBe("id なし");
  });

  it("未決は「id 論点（要る情報: …）」", () => {
    expect(summarizeOpen({ id: "Q2", 論点: "いつ出すか", 要る情報: "人の判断" })).toBe("Q2 いつ出すか（要る情報: 人の判断）");
  });

  it("ほかの配列のオブジェクトは「キー: 値」を並べ、[object Object] にしない", () => {
    expect(summarizeItem("確認したこと", { 対象: "README", 結果: ["読めた", "古い"] })).toBe("対象: README / 結果: 読めた、古い");
    expect(summarizeItem("メモ", "ただの文字")).toBe("ただの文字");
  });
});

describe("selectDetailed: 詳しく載せる決定", () => {
  it("暫定・直近・それらが依存する決定を選ぶ（1 段だけ）", () => {
    const list = [d(1), d(2), d(3, "暫定", { 依存: ["D1"] }), d(4), d(5), d(6, "確定", { 依存: ["D2"] })];
    // 直近 2 件（D5, D6）と暫定（D3）、その依存（D1, D2）
    expect([...selectDetailed(list, 2)].sort()).toEqual([0, 1, 2, 4, 5]);
  });

  it("上限があれば、直近 → その依存 → 暫定 → その依存の順に選ぶ", () => {
    const list = [d(1), d(2), d(3, "暫定", { 依存: ["D1"] }), d(4), d(5), d(6, "確定", { 依存: ["D2"] })];
    // D6, D5（直近）→ D2（D6 の依存）で 3 件。暫定の D3 と、その依存の D1 は 1 行になる
    expect([...selectDetailed(list, 2, [], 3)].sort()).toEqual([1, 4, 5]);
  });

  it("focus に名指しされた決定も選ぶ", () => {
    const list = [d(1), d(2), d(3), d(4)];
    expect(selectDetailed(list, 1, ["D1"]).has(0)).toBe(true);
    expect(selectDetailed(list, 1, ["D1"]).has(1)).toBe(false);
  });
});

describe("renderDecisions: プロンプトの決定の節", () => {
  it("詳しく載せないものは 1 行にし、次の id と退避の数を書く", () => {
    const lines = renderDecisions([d(1), d(2), d(3)], { recent: 1, detail: 6, archivedCount: 4, nextId: "D8" }).join("\n");
    expect(lines).toContain("    - D1 [確定] 決定1");
    expect(lines).not.toContain("前提1");
    expect(lines).toContain("    - D3 [確定] 決定3");
    expect(lines).toContain("        - 前提: 前提3");
    expect(lines).toContain("ほかに 4 件を .ctx/state/archive.jsonl に退避した");
    expect(lines).toContain("新しい決定の id は D8 から振る");
    expect(lines).not.toContain("[object Object]");
  });

  it("退避から呼び戻した決定は詳しく載せる", () => {
    const lines = renderDecisions([d(5)], { recent: 1, detail: 6, recalled: [d(1)], archivedCount: 1, nextId: "D6" }).join("\n");
    expect(lines).toContain("退避した決定のうち、今回の指示に関係するもの:");
    expect(lines).toContain("前提: 前提1");
  });

  it("決定も退避もなければ何も書かない", () => {
    expect(renderDecisions([], { recent: 5, detail: 6, archivedCount: 0, nextId: "D1" })).toEqual([]);
  });
});

describe("id", () => {
  it("次の決定の id は、current と退避分の最大の次", () => {
    expect(nextDecisionId(stateOf([d(2), d(5)]))).toBe("D6");
    expect(nextDecisionId(stateOf([d(2)], { [ARCHIVED_IDS_KEY]: ["D9", "Q3"] }))).toBe("D10");
    expect(nextDecisionId(stateOf([]))).toBe("D1");
  });

  it("id のない未決に Q を振る。使用済み（退避分を含む）とは重ねない", () => {
    expect(assignOpenIds([{ 論点: "a" }, { id: "Q2", 論点: "b" }, { 論点: "c" }], ["Q4"])).toEqual([
      { id: "Q5", 論点: "a" },
      { id: "Q2", 論点: "b" },
      { id: "Q6", 論点: "c" },
    ]);
  });
});

describe("planArchive: 退避", () => {
  const limits = { keep: 3, recent: 1, detail: 3, openDetail: 8 };

  it("上限以下なら何もしない", () => {
    const s = stateOf([d(1), d(2), d(3)]);
    expect(planArchive(s, limits, NOW)).toEqual({ state: s, archived: [] });
  });

  it("上限を超えたら、古い確定から移し、退避した id を覚える", () => {
    const { state, archived } = planArchive(stateOf([d(1), d(2), d(3), d(4), d(5)]), limits, NOW);
    expect((state["決定"] as { id: string }[]).map((x) => x.id)).toEqual(["D3", "D4", "D5"]);
    expect(archived.map((e) => [e.kind, e.item.id, e.archivedAt])).toEqual([
      ["決定", "D1", NOW.toISOString()],
      ["決定", "D2", NOW.toISOString()],
    ]);
    expect(state[ARCHIVED_IDS_KEY]).toEqual(["D1", "D2"]);
  });

  it("暫定と、詳しく載せる決定が依存するものは移さない（グラフの根拠を残す）", () => {
    const list = [d(1), d(2, "暫定"), d(3), d(4), d(5, "確定", { 依存: ["D1"] })];
    const { state } = planArchive(stateOf(list), limits, NOW);
    // D1 は D5（直近）が依存、D2 は暫定。古い確定で移せるのは D3 と D4
    expect((state["決定"] as { id: string }[]).map((x) => x.id)).toEqual(["D1", "D2", "D5"]);
  });

  it("確定・撤回だけで足りなければ、古い暫定も移す（詳しく載せる決定は移さない）", () => {
    const list = [1, 2, 3, 4, 5].map((n) => d(n, "暫定"));
    const { state } = planArchive(stateOf(list), { ...limits, detail: 1 }, NOW);
    expect((state["決定"] as { id: string }[]).map((x) => x.id)).toEqual(["D3", "D4", "D5"]);
  });

  it("解決した未決は、件数によらずすぐ移す", () => {
    const s = stateOf([d(1)], { 未決: [{ id: "Q1", 論点: "a", 状態: "解決" }, { id: "Q2", 論点: "b" }] });
    const { state, archived } = planArchive(s, limits, NOW);
    expect(state["未決"]).toEqual([{ id: "Q2", 論点: "b" }]);
    expect(archived.map((e) => [e.kind, e.item.id])).toEqual([["未決", "Q1"]]);
    expect(state[ARCHIVED_IDS_KEY]).toEqual(["Q1"]);
  });
});

describe("archive.jsonl", () => {
  const entries: ArchiveEntry[] = [
    { kind: "決定", item: d(1), archivedAt: "t1" },
    { kind: "未決", item: { id: "Q1", 論点: "a" }, archivedAt: "t1" },
    { kind: "決定", item: d(1, "撤回"), archivedAt: "t2" },
  ];

  it("書いた行を読み戻せる。壊れた行は飛ばす", () => {
    expect(parseArchive(formatArchive(entries) + "{壊れた行\n")).toEqual(entries);
  });

  it("退避した決定は、同じ id なら後のものを残す", () => {
    expect(archivedDecisions(entries)).toEqual([d(1, "撤回")]);
  });

  it("グラフ用には退避分を前に足す。current で書き直された id は current を正とする", () => {
    const merged = withArchived(stateOf([d(1, "暫定"), d(5)]), [...entries, { kind: "決定", item: d(2), archivedAt: "t3" }]);
    expect((merged["決定"] as { id: string; 状態: string }[]).map((x) => `${x.id}:${x.状態}`)).toEqual(["D2:確定", "D1:暫定", "D5:確定"]);
  });
});

describe("renderOpen: プロンプトの未決の節", () => {
  it("新しい max 件は要る情報まで、古いものは id と論点の 1 行", () => {
    const items = [1, 2, 3].map((n) => ({ id: `Q${n}`, 論点: `論点${n}`, 要る情報: `情報${n}` }));
    expect(renderOpen(items, 2)).toEqual([
      "- **未決**:",
      "    - Q1 論点1",
      "    - Q2 論点2（要る情報: 情報2）",
      "    - Q3 論点3（要る情報: 情報3）",
    ]);
    expect(renderOpen([], 2)).toEqual([]);
  });
});
