import { describe, expect, it } from "vitest";
import { buildPostToolUseHook, buildSdkOptions } from "../src/core/agent.js";
import {
  ALL_LAYERS,
  ContextBudget,
  DEFAULT_CONFIG,
  type ContextBudgetConfig,
} from "../src/core/contextbudget.js";
import type { FileFacts } from "../src/core/readplan.js";

const cfg = (over: Partial<ContextBudgetConfig> = {}): ContextBudgetConfig => ({
  ...DEFAULT_CONFIG,
  ...over,
});

/** 行数を固定で返す facts。fs に触らない。 */
const facts = (lines: number, bytes: number | null = null) => (): FileFacts => ({
  lines,
  bytes,
});

describe("[1] 隔離の判定", () => {
  it("調査の指示は隔離する", () => {
    const b = new ContextBudget();
    expect(b.planIsolation("認証まわりがどこにあるか調べて")).toBe(true);
    expect(b.ledger().isolated).toBe(true);
  });

  it("編集の指示は隔離しない", () => {
    const b = new ContextBudget();
    expect(b.planIsolation("このバグを直して")).toBe(false);
  });

  it("層をOFFにすると調査でも隔離しない", () => {
    const b = new ContextBudget(cfg({ layers: { ...ALL_LAYERS, isolate: false } }));
    expect(b.planIsolation("どこにあるか調べて")).toBe(false);
  });
});

describe("[2] 入力を絞る", () => {
  it("大きいファイルの Read に範囲を足す", () => {
    const b = new ContextBudget();
    const r = b.planInput("Read", { file_path: "big.ts" }, facts(5000));
    expect(r).not.toBeNull();
    expect(r!.updatedInput.limit).toBe(DEFAULT_CONFIG.read.windowLines);
    expect(b.ledger().narrowedCalls).toBe(1);
  });

  it("小さいファイルは触らない", () => {
    const b = new ContextBudget();
    expect(b.planInput("Read", { file_path: "small.ts" }, facts(10))).toBeNull();
    expect(b.ledger().narrowedCalls).toBe(0);
  });

  it("出力が膨らむ Bash を head で包む", () => {
    const b = new ContextBudget();
    const r = b.planInput("Bash", { command: "cat huge.log" }, facts(0));
    expect(r).not.toBeNull();
    expect(r!.updatedInput.command).toContain("head -200");
  });

  it("層をOFFにすると絞らない", () => {
    const b = new ContextBudget(cfg({ layers: { ...ALL_LAYERS, narrowInput: false } }));
    expect(b.planInput("Read", { file_path: "big.ts" }, facts(5000))).toBeNull();
  });

  it("関係ないツールは触らない", () => {
    const b = new ContextBudget();
    expect(b.planInput("Write", { file_path: "a.ts", content: "x" }, facts(5000))).toBeNull();
  });
});

describe("[3] 出力を削る", () => {
  it("上限超えの出力を中略する", () => {
    const b = new ContextBudget();
    const out = b.applyOutput("Read", "x".repeat(20000));
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(20000);
  });

  it("上限内は触らない", () => {
    const b = new ContextBudget();
    expect(b.applyOutput("Read", "tiny")).toBeNull();
  });

  it("層をOFFにすると削らない", () => {
    const b = new ContextBudget(cfg({ layers: { ...ALL_LAYERS, trimOutput: false } }));
    expect(b.applyOutput("Read", "x".repeat(20000))).toBeNull();
    expect(b.ledger().outputReport).toBeUndefined();
  });
});

describe("3層の直列合成", () => {
  it("同じターンで [1][2][3] が全て記録される", () => {
    const b = new ContextBudget();
    b.planIsolation("構成を調べて");
    b.planInput("Read", { file_path: "big.ts" }, facts(5000));
    b.applyOutput("Read", "y".repeat(20000));

    const l = b.ledger();
    expect(l.isolated).toBe(true);
    expect(l.narrowedCalls).toBe(1);
    expect(l.outputReport?.trimmedCalls).toBe(1);
  });

  it("[2] で絞った後に [3] がかかる（二段目として動く）", () => {
    const b = new ContextBudget();
    // [2] が範囲を足し、その結果の出力に [3] がかかる
    const narrowed = b.planInput("Read", { file_path: "big.ts" }, facts(5000));
    expect(narrowed).not.toBeNull();
    const trimmed = b.applyOutput("Read", "z".repeat(20000));
    expect(trimmed).not.toBeNull();
    // 両方の層が別々に記録されている
    expect(b.ledger().narrowedCalls).toBe(1);
    expect(b.ledger().outputReport?.trimmedCalls).toBe(1);
  });

  it("層をまたいだ合算削減率を出さない（分母が違うため二重計上になる）", () => {
    const b = new ContextBudget();
    b.planInput("Read", { file_path: "big.ts" }, facts(5000));
    b.applyOutput("Read", "z".repeat(20000));
    const s = b.summary()!;
    // 入力と出力は別の記述として出る。合算した1つの率にしない
    expect(s).toContain("入力を");
    expect(s).toContain("出力");
    // 「合計」「累計」といった層跨ぎの合算表現を出さない
    expect(s).not.toMatch(/合計|累計|総削減/);
  });
});

describe("summary", () => {
  it("何も効かなかったターンでは null（無音にする）", () => {
    const b = new ContextBudget();
    b.planIsolation("ありがとう");
    expect(b.summary()).toBeNull();
  });

  it("効いた層だけを述べる", () => {
    const b = new ContextBudget();
    b.planIsolation("どこにあるか調べて");
    const s = b.summary()!;
    expect(s).toContain("隔離");
    // 絞っていない・削っていないので、それらは出さない
    expect(s).not.toContain("入力を");
    expect(s).not.toContain("出力");
  });

  it("全層OFFなら常に null", () => {
    const b = new ContextBudget(
      cfg({ layers: { isolate: false, narrowInput: false, trimOutput: false } }),
    );
    b.planIsolation("調べて");
    b.planInput("Read", { file_path: "big.ts" }, facts(5000));
    b.applyOutput("Read", "x".repeat(20000));
    expect(b.summary()).toBeNull();
  });
});

describe("SDK への配線", () => {
  it("[3] 削るときだけ updatedToolOutput を返す", async () => {
    const hook = buildPostToolUseHook(new ContextBudget());
    const big = await hook({ tool_name: "Read", tool_response: "x".repeat(20000) });
    const spec = (big as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput;
    expect(spec?.hookEventName).toBe("PostToolUse");
    expect((spec?.updatedToolOutput as string).length).toBeLessThan(20000);
  });

  it("[3] 削る必要がなければ空を返す（恒等の差し替えは他フックの削減を打ち消す）", async () => {
    const hook = buildPostToolUseHook(new ContextBudget());
    expect(await hook({ tool_name: "Read", tool_response: "tiny" })).toEqual({});
  });

  it("ツール名が取れない入力では何もしない", async () => {
    const hook = buildPostToolUseHook(new ContextBudget());
    expect(await hook({})).toEqual({});
  });

  it("budget を渡すと PostToolUse が載る", () => {
    const o = buildSdkOptions({ cwd: "/r", mode: "recent", budget: new ContextBudget() });
    expect((o.hooks as { PostToolUse?: unknown[] }).PostToolUse).toBeDefined();
  });

  it("budget を渡さないなら hooks を載せない（既存の挙動を変えない）", () => {
    expect(buildSdkOptions({ cwd: "/r", mode: "recent" }).hooks).toBeUndefined();
  });

  it("[1] 隔離するターンだけ agents が載る", () => {
    const on = buildSdkOptions({ cwd: "/r", mode: "recent", isolating: true });
    expect((on.agents as Record<string, unknown>).explorer).toBeDefined();
    const off = buildSdkOptions({ cwd: "/r", mode: "recent", isolating: false });
    expect(off.agents).toBeUndefined();
  });
});
