import { describe, expect, it } from "vitest";
import { buildRunRecord, formatRunLine, parseRunLog, summarize } from "../src/core/metrics.js";

describe("buildRunRecord", () => {
  it("モードとトークンを記録する", () => {
    const r = buildRunRecord({
      mode: "recent",
      instruction: "日報を書いて",
      usage: { inputTokens: 1200, outputTokens: 300 },
      statePatched: true,
      now: new Date("2026-09-10T01:00:00Z"),
    });
    expect(r.mode).toBe("recent");
    expect(r.in).toBe(1200);
    expect(r.out).toBe(300);
    expect(r.patched).toBe(true);
    expect(r.at).toBe("2026-09-10T01:00:00.000Z");
  });

  it("指示は先頭だけ残す（ログにプロンプト全文を残さない）", () => {
    const r = buildRunRecord({
      mode: "stateless",
      instruction: "あ".repeat(300),
      usage: { inputTokens: 1, outputTokens: 1 },
      statePatched: false,
      now: new Date(),
    });
    expect(r.instruction.length).toBeLessThanOrEqual(80);
  });

  it("usage が無いターンでも記録できる（失敗も残す）", () => {
    const r = buildRunRecord({
      mode: "full",
      instruction: "x",
      usage: undefined,
      statePatched: false,
      now: new Date(),
    });
    expect(r.in).toBe(0);
    expect(r.out).toBe(0);
  });

  it("rate_limit を持っていれば残す", () => {
    const r = buildRunRecord({
      mode: "recent",
      instruction: "x",
      usage: { inputTokens: 1, outputTokens: 1 },
      statePatched: false,
      rateLimit: { five_hour: { remaining: 42 } },
      now: new Date(),
    });
    expect(r.rate_limit).toEqual({ five_hour: { remaining: 42 } });
  });
});

describe("formatRunLine", () => {
  it("末尾が改行の1行 JSON（jsonl として追記できる）", () => {
    const line = formatRunLine(
      buildRunRecord({
        mode: "recent",
        instruction: "x",
        usage: { inputTokens: 1, outputTokens: 2 },
        statePatched: false,
        now: new Date(),
      }),
    );
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
    expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe("summarize", () => {
  const rows = [
    { mode: "stateless", in: 100, out: 10 },
    { mode: "stateless", in: 200, out: 20 },
    { mode: "recent", in: 500, out: 30 },
  ];

  it("モードごとに平均入力トークンを出す", () => {
    const s = summarize(rows as never);
    expect(s.stateless.turns).toBe(2);
    expect(s.stateless.avgIn).toBe(150);
    expect(s.recent.avgIn).toBe(500);
  });

  it("空でも落ちない", () => {
    expect(summarize([])).toEqual({});
  });
});

describe("キャッシュ指標をログに残す", () => {
  it("cache_read / cache_creation を記録する", () => {
    const r = buildRunRecord({
      mode: "recent",
      instruction: "テスト",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 8000,
        cacheCreationTokens: 200,
      },
      statePatched: true,
      now: new Date("2026-09-11T00:00:00Z"),
    });
    expect(r.cache_read).toBe(8000);
    expect(r.cache_create).toBe(200);
  });

  it("キャッシュが効いていないターンは 0 で残る（見逃さないため）", () => {
    const r = buildRunRecord({
      mode: "stateless",
      instruction: "テスト",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
      statePatched: false,
      now: new Date("2026-09-11T00:00:00Z"),
    });
    expect(r.cache_read).toBe(0);
  });
});

describe("summarize のキャッシュ集計", () => {
  const row = (mode: "stateless" | "recent", cacheRead: number, cacheCreate: number) => ({
    at: "2026-09-11T00:00:00.000Z",
    mode,
    instruction: "x",
    in: 1000,
    out: 100,
    cache_read: cacheRead,
    cache_create: cacheCreate,
    patched: true,
  });

  it("キャッシュ読み込みの平均を出す", () => {
    const s = summarize([row("recent", 8000, 100), row("recent", 4000, 100)]);
    expect(s.recent.avgCacheRead).toBe(6000);
  });

  it("キャッシュヒット率を出す（読めた分 / 入力全体）", () => {
    // in=1000, cache_read=9000 → 全入力 10000 のうち 9000 がキャッシュ
    const s = summarize([row("recent", 9000, 0)]);
    expect(s.recent.cacheHitRate).toBeCloseTo(0.9, 2);
  });

  it("キャッシュが全ミスなら 0 になる（引き継げていないと分かる）", () => {
    const s = summarize([row("stateless", 0, 5000)]);
    expect(s.stateless.cacheHitRate).toBe(0);
  });

  it("古いログ（キャッシュ欄なし）でも落ちない", () => {
    const legacy = {
      at: "2026-09-11T00:00:00.000Z",
      mode: "recent" as const,
      instruction: "x",
      in: 1000,
      out: 100,
      patched: true,
    } as never;
    const s = summarize([legacy]);
    expect(s.recent.avgCacheRead).toBe(0);
  });
});

describe("膨張しているかを見る", () => {
  const row = (mode: "stateless" | "recent", cacheRead: number, at: string) => ({
    at,
    mode,
    instruction: "x",
    in: 20,
    out: 1000,
    cache_read: cacheRead,
    cache_create: 0,
    patched: true,
  });

  it("最初と最後の cache_read を持つ（膨張の有無を見るため）", () => {
    const s = summarize([
      row("recent", 100_000, "2026-09-12T03:00:00.000Z"),
      row("recent", 400_000, "2026-09-12T03:10:00.000Z"),
      row("recent", 600_000, "2026-09-12T03:20:00.000Z"),
    ]);
    expect(s.recent.firstCacheRead).toBe(100_000);
    expect(s.recent.lastCacheRead).toBe(600_000);
  });

  it("時刻順に並んでいなくても最初と最後を正しく取る", () => {
    const s = summarize([
      row("recent", 600_000, "2026-09-12T03:20:00.000Z"),
      row("recent", 100_000, "2026-09-12T03:00:00.000Z"),
    ]);
    expect(s.firstCacheRead ?? s.recent.firstCacheRead).toBe(100_000);
    expect(s.recent.lastCacheRead).toBe(600_000);
  });

  it("1ターンだけなら最初と最後が同じ", () => {
    const s = summarize([row("stateless", 5_000, "2026-09-12T03:00:00.000Z")]);
    expect(s.stateless.firstCacheRead).toBe(5_000);
    expect(s.stateless.lastCacheRead).toBe(5_000);
  });

  it("1ターンあたりの増加量を出す（膨張の速さ）", () => {
    const s = summarize([
      row("recent", 100_000, "2026-09-12T03:00:00.000Z"),
      row("recent", 300_000, "2026-09-12T03:10:00.000Z"),
      row("recent", 500_000, "2026-09-12T03:20:00.000Z"),
    ]);
    // (500k - 100k) / (3-1) = 200k
    expect(s.recent.growthPerTurn).toBe(200_000);
  });

  it("1ターンだけなら増加量は 0", () => {
    const s = summarize([row("recent", 100_000, "2026-09-12T03:00:00.000Z")]);
    expect(s.recent.growthPerTurn).toBe(0);
  });
});

describe("parseRunLog — 連結してしまった行を捨てない", () => {
  const rec = (out: number) =>
    JSON.stringify({
      at: "2026-09-12T04:00:00.000Z",
      mode: "recent",
      instruction: "x",
      in: 10,
      out,
      cache_read: 100,
      cache_create: 0,
      patched: true,
    });

  it("改行が抜けて2件連結した行から両方拾う", () => {
    const raw = `${rec(100)}${rec(200)}\n`;
    const rows = parseRunLog(raw);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.out)).toEqual([100, 200]);
  });

  it("3件連結でも全部拾う", () => {
    const raw = `${rec(1)}${rec(2)}${rec(3)}`;
    expect(parseRunLog(raw)).toHaveLength(3);
  });

  it("正常な行と連結した行が混ざっていても全部拾う", () => {
    const raw = [rec(1), `${rec(2)}${rec(3)}`, rec(4)].join("\n");
    expect(parseRunLog(raw)).toHaveLength(4);
  });

  it("本当に壊れた断片は捨てる（復元できないものは諦める）", () => {
    const raw = `${rec(1)}\n{"at":"x","mode":`;
    expect(parseRunLog(raw)).toHaveLength(1);
  });

  it("空の入力では空を返す", () => {
    expect(parseRunLog("")).toEqual([]);
  });
});
