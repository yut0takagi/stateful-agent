import { describe, expect, it } from "vitest";
import { diffLines, summarizeToolUse, renderBashResult } from "../src/core/toolview.js";

describe("diffLines", () => {
  it("追加された行を + として返す", () => {
    const d = diffLines("a\nb", "a\nb\nc");
    expect(d.filter((x) => x.kind === "add").map((x) => x.text)).toEqual(["c"]);
    expect(d.filter((x) => x.kind === "del")).toHaveLength(0);
  });

  it("削除された行を - として返す", () => {
    const d = diffLines("a\nb\nc", "a\nc");
    expect(d.filter((x) => x.kind === "del").map((x) => x.text)).toEqual(["b"]);
  });

  it("変更なしは全部 same", () => {
    const d = diffLines("a\nb", "a\nb");
    expect(d.every((x) => x.kind === "same")).toBe(true);
  });

  it("行の置換は del + add になる", () => {
    const d = diffLines("a\nX\nc", "a\nY\nc");
    expect(d.filter((x) => x.kind === "del").map((x) => x.text)).toEqual(["X"]);
    expect(d.filter((x) => x.kind === "add").map((x) => x.text)).toEqual(["Y"]);
  });

  it("新規ファイル（旧が空）は全行 add", () => {
    const d = diffLines("", "a\nb");
    expect(d.filter((x) => x.kind === "add")).toHaveLength(2);
  });
});

describe("summarizeToolUse", () => {
  it("Write は path と差分カウントを出す", () => {
    const c = summarizeToolUse("Write", { file_path: "/r/a.ts", content: "x\ny\n" }, "x\n");
    expect(c.kind).toBe("diff");
    expect(c.title).toContain("a.ts");
    expect(c.added).toBe(1);
    expect(c.removed).toBe(0);
  });

  it("Edit は old_string/new_string から差分を作る", () => {
    const c = summarizeToolUse(
      "Edit",
      { file_path: "/r/a.ts", old_string: "foo", new_string: "bar" },
      "let foo = 1\n",
    );
    expect(c.kind).toBe("diff");
    expect(c.added).toBeGreaterThan(0);
  });

  it("Bash はコマンドを見出しにする", () => {
    const c = summarizeToolUse("Bash", { command: "npm test" }, null);
    expect(c.kind).toBe("command");
    expect(c.title).toBe("npm test");
  });

  it("Read などは1行の見出しだけ", () => {
    const c = summarizeToolUse("Read", { file_path: "/r/a.ts" }, null);
    expect(c.kind).toBe("plain");
    expect(c.title).toContain("a.ts");
  });

  it("長い差分は打ち切る（ログが埋まらないように）", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
    const c = summarizeToolUse("Write", { file_path: "/r/big.ts", content: big }, "");
    expect(c.lines!.length).toBeLessThanOrEqual(60);
    expect(c.truncated).toBe(true);
  });
});

describe("renderBashResult", () => {
  it("長い出力は先頭3行だけ出す", () => {
    const out = Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n");
    const r = renderBashResult(out);
    expect(r.lines).toEqual(["l0", "l1", "l2"]);
    expect(r.truncated).toBe(true);
  });

  it("省略した行数を持つ（何行隠れたか分かるように）", () => {
    const out = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    const r = renderBashResult(out);
    expect(r.omitted).toBe(7);
  });

  it("3行ちょうどなら打ち切らない", () => {
    const r = renderBashResult("a\nb\nc");
    expect(r.lines).toEqual(["a", "b", "c"]);
    expect(r.truncated).toBe(false);
    expect(r.omitted).toBe(0);
  });

  it("短い出力はそのまま", () => {
    const r = renderBashResult("ok");
    expect(r.lines).toEqual(["ok"]);
    expect(r.truncated).toBe(false);
  });

  it("空行だけの末尾は数えない", () => {
    const r = renderBashResult("ok\n");
    expect(r.lines).toEqual(["ok"]);
    expect(r.truncated).toBe(false);
  });

  it("出力が空なら空のまま", () => {
    const r = renderBashResult("");
    expect(r.truncated).toBe(false);
    expect(r.omitted).toBe(0);
  });
});
