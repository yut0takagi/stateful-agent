/**
 * 対照実験ベンチのテスト。
 *
 * モードごとに同じプロンプト列を流し、ターンを重ねたときの伸び方を比べる。
 * 実験の再現性は「同じ順序で同じ入力を流す」ことに依存するので、そこを固める。
 */

import { describe, expect, it } from "vitest";
import {
  buildComparison,
  nextPrompt,
  parseScenario,
  summarizeTools,
  type BenchTurn,
} from "../src/bench/scenario.js";

describe("parseScenario — シナリオを読む", () => {
  it("見出しなしの行をプロンプトとして読む", () => {
    const s = parseScenario("1つ目の指示\n2つ目の指示\n");
    expect(s.prompts).toEqual(["1つ目の指示", "2つ目の指示"]);
  });

  it("空行とコメントは飛ばす", () => {
    const s = parseScenario("# これはコメント\n\n本文\n\n# また\n次\n");
    expect(s.prompts).toEqual(["本文", "次"]);
  });

  it("前後の空白は落とす", () => {
    expect(parseScenario("  指示  \n").prompts).toEqual(["指示"]);
  });

  it("空のシナリオは空", () => {
    expect(parseScenario("").prompts).toEqual([]);
  });
});

describe("nextPrompt — 無限に回す", () => {
  const s = { prompts: ["A", "B", "C"] };

  it("順に返す", () => {
    expect(nextPrompt(s, 0)).toBe("A");
    expect(nextPrompt(s, 1)).toBe("B");
    expect(nextPrompt(s, 2)).toBe("C");
  });

  it("末尾まで行ったら先頭に戻る（無限ラリー）", () => {
    expect(nextPrompt(s, 3)).toBe("A");
    expect(nextPrompt(s, 4)).toBe("B");
  });

  it("プロンプトが無ければ null", () => {
    expect(nextPrompt({ prompts: [] }, 0)).toBeNull();
  });
});

describe("buildComparison — モード別の伸び方を比べる", () => {
  const turn = (
    mode: string,
    index: number,
    cacheRead: number,
    out: number,
  ): BenchTurn => ({
    mode,
    index,
    inputTokens: 20,
    outputTokens: out,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: 0,
    costUSD: 1,
    ms: 1000,
    statePatched: true,
    stateBytes: 100,
  });

  it("モードごとにまとめる", () => {
    const c = buildComparison([
      turn("stateless", 0, 100, 500),
      turn("recent", 0, 100, 500),
    ]);
    expect(Object.keys(c).sort()).toEqual(["recent", "stateless"]);
  });

  it("ターンごとの累積コストを出す", () => {
    const c = buildComparison([turn("recent", 0, 100, 500), turn("recent", 1, 200, 500)]);
    expect(c.recent.totalCostUSD).toBe(2);
  });

  it("cache_read の傾き（1ターンあたりの増加）を出す", () => {
    const c = buildComparison([
      turn("recent", 0, 100_000, 500),
      turn("recent", 1, 300_000, 500),
      turn("recent", 2, 500_000, 500),
    ]);
    expect(c.recent.cacheGrowthPerTurn).toBe(200_000);
  });

  it("out の平均を出す", () => {
    const c = buildComparison([turn("recent", 0, 100, 400), turn("recent", 1, 100, 600)]);
    expect(c.recent.avgOut).toBe(500);
  });

  it("index 順に並べ直してから傾きを出す（到着順に依存しない）", () => {
    const c = buildComparison([
      turn("recent", 2, 500_000, 500),
      turn("recent", 0, 100_000, 500),
      turn("recent", 1, 300_000, 500),
    ]);
    expect(c.recent.cacheGrowthPerTurn).toBe(200_000);
  });

  it("1ターンだけなら傾きは 0", () => {
    const c = buildComparison([turn("recent", 0, 100, 500)]);
    expect(c.recent.cacheGrowthPerTurn).toBe(0);
  });

  it("state のサイズ推移も持つ（膨らみ続けないか見る）", () => {
    const a = turn("recent", 0, 100, 500);
    const b = { ...turn("recent", 1, 100, 500), stateBytes: 5000 };
    const c = buildComparison([a, b]);
    expect(c.recent.lastStateBytes).toBe(5000);
  });

  it("所要時間の平均も出す（体感の重さ）", () => {
    const a = { ...turn("recent", 0, 100, 500), ms: 1000 };
    const b = { ...turn("recent", 1, 100, 500), ms: 3000 };
    expect(buildComparison([a, b]).recent.avgMs).toBe(2000);
  });

  it("空の入力では空の比較", () => {
    expect(buildComparison([])).toEqual({});
  });
});

describe("summarizeTools — セッション内で何をしたかを残す", () => {
  it("ツール名ごとの回数を数える", () => {
    const s = summarizeTools([
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Read", input: { file_path: "/b.ts" } },
      { name: "Bash", input: { command: "ls" } },
    ]);
    expect(s.counts).toEqual({ Read: 2, Bash: 1 });
  });

  it("読んだファイルを重複なく集める（何を見て答えたかが分かる）", () => {
    const s = summarizeTools([
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Read", input: { file_path: "/a.ts" } },
      { name: "Read", input: { file_path: "/b.ts" } },
    ]);
    expect(s.filesRead.sort()).toEqual(["/a.ts", "/b.ts"]);
  });

  it("Grep や Glob のパターンも拾う（探索の跡）", () => {
    const s = summarizeTools([
      { name: "Grep", input: { pattern: "TODO" } },
      { name: "Glob", input: { pattern: "**/*.swift" } },
    ]);
    expect(s.patterns.sort()).toEqual(["**/*.swift", "TODO"]);
  });

  it("Bash のコマンドは先頭だけ残す（ログが肥大しないように）", () => {
    const s = summarizeTools([
      { name: "Bash", input: { command: "make test && echo done && ls -la /very/long/path" } },
    ]);
    expect(s.commands[0].length).toBeLessThanOrEqual(60);
  });

  it("総呼び出し回数を持つ", () => {
    const s = summarizeTools([
      { name: "Read", input: {} },
      { name: "Bash", input: {} },
    ]);
    expect(s.total).toBe(2);
  });

  it("ツールを使わないターンでも落ちない", () => {
    const s = summarizeTools([]);
    expect(s.total).toBe(0);
    expect(s.filesRead).toEqual([]);
  });

  it("入力が想定外の形でも落ちない", () => {
    const s = summarizeTools([{ name: "Read", input: { file_path: 123 } as never }]);
    expect(s.filesRead).toEqual([]);
  });
});
