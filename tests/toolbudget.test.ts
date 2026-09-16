import { describe, expect, it } from "vitest";
import {
  categoryOf,
  DEFAULT_LIMITS,
  toText,
  trimMiddle,
  TurnBudget,
} from "../src/core/toolbudget.js";

describe("categoryOf", () => {
  it("ファイル読み取り系を read に寄せる", () => {
    expect(categoryOf("Read")).toBe("read");
    expect(categoryOf("NotebookRead")).toBe("read");
  });

  it("コマンド実行系を bash に寄せる", () => {
    expect(categoryOf("Bash")).toBe("bash");
    expect(categoryOf("BashOutput")).toBe("bash");
  });

  it("検索系を search に寄せる", () => {
    expect(categoryOf("Grep")).toBe("search");
    expect(categoryOf("Glob")).toBe("search");
  });

  it("知らないツールは other", () => {
    expect(categoryOf("mcp__slack__post")).toBe("other");
  });
});

describe("toText", () => {
  it("文字列はそのまま", () => {
    expect(toText("abc")).toBe("abc");
  });

  it("content 配列のテキストブロックを繋ぐ", () => {
    expect(toText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  it("stdout を持つオブジェクトから取り出す", () => {
    expect(toText({ stdout: "out" })).toBe("out");
  });

  it("content を入れ子で持つオブジェクトを辿る", () => {
    expect(toText({ content: [{ type: "text", text: "x" }] })).toBe("x");
  });

  it("テキストが取れない構造は null（触らない判断に使う）", () => {
    expect(toText([{ type: "image", source: "..." }])).toBeNull();
    expect(toText(null)).toBeNull();
    expect(toText(42)).toBeNull();
  });
});

describe("trimMiddle", () => {
  it("上限内なら手を付けない", () => {
    const r = trimMiddle("short", 100);
    expect(r.trimmed).toBe(false);
    expect(r.text).toBe("short");
  });

  it("上限を超えたら中略する", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const r = trimMiddle(text, 500);
    expect(r.trimmed).toBe(true);
    expect(r.text.length).toBeLessThan(text.length);
  });

  it("頭と尾の両方を残す（末尾を捨てると結論が読めず打ち直される）", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const r = trimMiddle(text, 500);
    expect(r.text).toContain("line 0");
    expect(r.text).toContain("line 499");
  });

  it("中略したことと全体の行数を明示する", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const r = trimMiddle(text, 500);
    // 黙って切るとモデルが「ここで終わり」と誤読するので必ず告知する
    expect(r.text).toContain("中略");
    expect(r.text).toContain("500 行");
    // 読み直し方を示す（削減が打ち直しで打ち消されないように）
    expect(r.text).toMatch(/offset|grep|sed/);
  });

  it("行境界で切る（行途中で切ると壊れた構文をモデルが実在と読む）", () => {
    const text = Array.from({ length: 200 }, (_, i) => `{"key": ${i}}`).join("\n");
    const r = trimMiddle(text, 400);
    const body = r.text.split("\n").filter((l) => l.startsWith("{"));
    for (const line of body) {
      expect(line).toMatch(/^\{"key": \d+\}$/);
    }
  });

  it("削った分だけ keptChars が減る", () => {
    const text = "x".repeat(10000);
    const r = trimMiddle(text, 1000);
    expect(r.originalChars).toBe(10000);
    expect(r.keptChars).toBeLessThanOrEqual(1000);
  });
});

describe("TurnBudget", () => {
  it("上限内の出力には差し替えを返さない（null = 元のまま通す）", () => {
    const b = new TurnBudget();
    expect(b.apply("Read", "short output")).toBeNull();
  });

  it("上限超えの出力を差し替える", () => {
    const b = new TurnBudget();
    const out = b.apply("Read", "x".repeat(DEFAULT_LIMITS.read * 2));
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(DEFAULT_LIMITS.read * 2);
  });

  it("読めない構造は触らない", () => {
    const b = new TurnBudget();
    expect(b.apply("Read", [{ type: "image" }])).toBeNull();
  });

  it("ターン合計を超えると以降を強く絞る", () => {
    const b = new TurnBudget({ ...DEFAULT_LIMITS, turnTotal: 1000 });
    // まず合計を使い切る
    b.apply("Bash", "y".repeat(5000));
    // 使い切った後は同じ入力でももっと短くなる
    const after = b.apply("Bash", "y".repeat(5000));
    expect(after).not.toBeNull();
    expect(after!.length).toBeLessThan(1500);
  });

  it("何をどれだけ削ったかを報告する", () => {
    const b = new TurnBudget();
    b.apply("Read", "x".repeat(20000));
    b.apply("Read", "small");
    const r = b.report();
    expect(r.calls).toBe(2);
    expect(r.trimmedCalls).toBe(1);
    expect(r.savedChars).toBeGreaterThan(0);
    expect(r.totalOriginalChars).toBeGreaterThan(r.totalKeptChars);
  });

  it("種別ごとに違う上限を使う", () => {
    const b = new TurnBudget({ ...DEFAULT_LIMITS, read: 5000, search: 500 });
    const read = b.apply("Read", "x".repeat(3000));
    const search = b.apply("Grep", "x".repeat(3000));
    // read は 5000 以内なので素通り、search は 500 で切られる
    expect(read).toBeNull();
    expect(search).not.toBeNull();
  });
});



describe("1行が上限より長い出力（minify JS / 改行なし JSON）", () => {
  it("本文を必ず残す（本文ゼロだとモデルが「空」と誤読する）", () => {
    const r = trimMiddle("x".repeat(20000), 4000);
    // 告知だけでなく中身が入っていること
    const withoutNotice = r.text.replace(/\n… \[stateful-agent:[\s\S]*?\] …\n/, "");
    expect(withoutNotice.length).toBeGreaterThan(1000);
  });

  it("keptChars が 0 にならない（-100% という誤報告を防ぐ）", () => {
    const r = trimMiddle("x".repeat(20000), 4000);
    expect(r.keptChars).toBeGreaterThan(0);
    expect(r.keptChars).toBeLessThanOrEqual(4000);
  });

  it("文字単位で切ったこと＝構文が壊れていることを明示する", () => {
    const r = trimMiddle("a".repeat(50000), 3000);
    expect(r.text).toContain("文字単位");
    expect(r.text).toMatch(/壊れ/);
  });

  it("削減率が 100% にならない", () => {
    const b = new TurnBudget();
    b.apply("Read", "x".repeat(20000));
    const rep = b.report();
    const pct = Math.round((rep.savedChars / rep.totalOriginalChars) * 100);
    expect(pct).toBeLessThan(100);
    expect(pct).toBeGreaterThan(0);
  });
});
