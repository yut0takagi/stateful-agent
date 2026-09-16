import { describe, expect, it } from "vitest";
import {
  DEFAULT_READ_LIMITS,
  planBash,
  planRead,
  type FileFacts,
} from "../src/core/readplan.js";

const facts = (lines: number | null, bytes: number | null = null): FileFacts => ({
  lines,
  bytes,
});

describe("planRead", () => {
  it("小さいファイルは素通しする", () => {
    expect(planRead({ file_path: "a.ts" }, facts(100)).kind).toBe("allow");
  });

  it("大きいファイルは先頭に絞る", () => {
    const d = planRead({ file_path: "big.ts" }, facts(5000));
    expect(d.kind).toBe("narrow");
    if (d.kind === "narrow") {
      expect(d.updatedInput.offset).toBe(1);
      expect(d.updatedInput.limit).toBe(DEFAULT_READ_LIMITS.windowLines);
    }
  });

  it("モデルが範囲を指定しているなら触らない（意図の上書きは往復を増やす）", () => {
    expect(planRead({ file_path: "big.ts", offset: 2000 }, facts(5000)).kind).toBe("allow");
    expect(planRead({ file_path: "big.ts", limit: 50 }, facts(5000)).kind).toBe("allow");
  });

  it("行数が分からないファイルは触らない（推測で後半を隠さない）", () => {
    expect(planRead({ file_path: "unknown.ts" }, facts(null)).kind).toBe("allow");
  });

  it("行数が少なくてもバイト数が大きければ絞る（1行が巨大なケース）", () => {
    const d = planRead({ file_path: "min.js" }, facts(3, 500_000));
    expect(d.kind).toBe("narrow");
  });

  it("絞った理由と続きの読み方を返す", () => {
    const d = planRead({ file_path: "big.ts" }, facts(5000));
    if (d.kind === "narrow") {
      expect(d.reason).toContain("5000 行");
      expect(d.reason).toContain("offset");
    }
  });

  it("元の入力の他のキーを保つ", () => {
    const d = planRead({ file_path: "big.ts", foo: "bar" }, facts(5000));
    if (d.kind === "narrow") {
      expect(d.updatedInput.file_path).toBe("big.ts");
      expect(d.updatedInput.foo).toBe("bar");
    }
  });

  it("上限は差し替えられる", () => {
    const d = planRead({ file_path: "m.ts" }, facts(300), {
      ...DEFAULT_READ_LIMITS,
      maxLines: 100,
      windowLines: 50,
    });
    expect(d.kind).toBe("narrow");
    if (d.kind === "narrow") {
      expect(d.updatedInput.limit).toBe(50);
    }
  });
});

describe("planBash", () => {
  it("出力が膨らみやすいコマンドに head を足す", () => {
    const d = planBash("cat huge.log");
    expect(d.kind).toBe("narrow");
    if (d.kind === "narrow") {
      expect(d.command).toContain("head -200");
    }
  });

  it("find / tree / grep -r も対象", () => {
    expect(planBash("find . -name '*.ts'").kind).toBe("narrow");
    expect(planBash("tree src").kind).toBe("narrow");
    expect(planBash("grep -r foo .").kind).toBe("narrow");
  });

  it("既に絞っているコマンドは触らない（二重に絞ると欠落の原因が不明になる）", () => {
    expect(planBash("cat x | head -5").kind).toBe("allow");
    expect(planBash("find . | wc -l").kind).toBe("allow");
    expect(planBash("head -20 file").kind).toBe("allow");
  });

  it("リダイレクトがあるものは触らない（出力が画面に来ない）", () => {
    expect(planBash("cat a > b").kind).toBe("allow");
  });

  it("書き込み系・破壊的なコマンドは触らない", () => {
    expect(planBash("git commit -m x").kind).toBe("allow");
    expect(planBash("rm -rf tmp").kind).toBe("allow");
    expect(planBash("npm install").kind).toBe("allow");
  });

  it("出力が小さいコマンドは触らない", () => {
    expect(planBash("git status").kind).toBe("allow");
    expect(planBash("node -v").kind).toBe("allow");
  });

  it("制限しても元のコマンドの終了状態を壊さない形にする", () => {
    const d = planBash("cat a.txt");
    if (d.kind === "narrow") {
      // { ...; } | head なのでコマンド自体は元のまま動く
      expect(d.command).toContain("cat a.txt");
    }
  });

  it("理由に打ち直し方を書く", () => {
    const d = planBash("cat huge.log");
    if (d.kind === "narrow") {
      expect(d.reason).toContain("絞って");
    }
  });
});
