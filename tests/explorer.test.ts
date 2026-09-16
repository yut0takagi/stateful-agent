import { describe, expect, it } from "vitest";
import { buildSdkOptions } from "../src/core/agent.js";
import {
  DELEGATE_HINT,
  EXPLORER,
  shouldDelegate,
  toAgentsOption,
} from "../src/core/explorer.js";

describe("EXPLORER の定義", () => {
  it("書き込み系ツールを与えない（探索が副作用を持つと規律を通らない書き込みになる）", () => {
    for (const forbidden of ["Write", "Edit", "NotebookEdit", "MultiEdit"]) {
      expect(EXPLORER.tools).not.toContain(forbidden);
    }
  });

  it("読み取りと検索のツールを持つ", () => {
    expect(EXPLORER.tools).toContain("Read");
    expect(EXPLORER.tools).toContain("Grep");
    expect(EXPLORER.tools).toContain("Glob");
  });

  it("読んだ内容が主スレッドに渡らないことをプロンプトで明示する", () => {
    expect(EXPLORER.prompt).toContain("主スレッドには渡らない");
  });

  it("結論・根拠・わからなかったことを報告させる", () => {
    expect(EXPLORER.prompt).toContain("答え");
    expect(EXPLORER.prompt).toContain("根拠");
    expect(EXPLORER.prompt).toContain("わからなかったこと");
  });

  it("ファイルの丸貼りを禁じる（それでは隔離の意味がない）", () => {
    expect(EXPLORER.prompt).toMatch(/丸ごと貼らない|長々と貼る/);
  });

  it("モデルを固定しない（安いモデルに固定すると誤報告で往復が増える）", () => {
    expect(EXPLORER.model).toBeUndefined();
  });
});

describe("shouldDelegate", () => {
  it("調査の指示は隔離する", () => {
    expect(shouldDelegate("認証まわりがどこで実装されてるか調べて")).toBe(true);
    expect(shouldDelegate("この関数の呼び出し元を探して")).toBe(true);
    expect(shouldDelegate("テストの構成を把握したい")).toBe(true);
  });

  it("編集・実装の指示は隔離しない（読んだ内容を手元に置くほうが正確）", () => {
    expect(shouldDelegate("このバグを直して")).toBe(false);
    expect(shouldDelegate("ログ出力を追加して")).toBe(false);
    expect(shouldDelegate("リファクタして")).toBe(false);
  });

  it("調査語と編集語が混ざるときは編集を優先する", () => {
    // 「調べて直す」は最終的に編集なので、読んだ内容が手元に要る
    expect(shouldDelegate("原因を調べて直して")).toBe(false);
  });

  it("空の指示は隔離しない", () => {
    expect(shouldDelegate("")).toBe(false);
    expect(shouldDelegate("   ")).toBe(false);
  });

  it("どちらとも読めない指示は隔離しない（誤って隔離すると編集の精度が落ちる）", () => {
    expect(shouldDelegate("ありがとう")).toBe(false);
    expect(shouldDelegate("次は？")).toBe(false);
  });
});

describe("toAgentsOption", () => {
  it("SDK の agents に渡せる形にする", () => {
    const o = toAgentsOption();
    expect(o.explorer).toBeDefined();
    expect(o.explorer.description).toBeTypeOf("string");
    expect(o.explorer.prompt).toBeTypeOf("string");
    expect(Array.isArray(o.explorer.tools)).toBe(true);
  });

  it("model を持たない定義では model キーを出さない", () => {
    expect("model" in toAgentsOption()).toBe(false);
    expect(toAgentsOption().explorer.model).toBeUndefined();
  });

  it("model を指定した定義では載せる", () => {
    const o = toAgentsOption({ ...EXPLORER, model: "sonnet" });
    expect(o.explorer.model).toBe("sonnet");
  });
});

describe("DELEGATE_HINT", () => {
  it("explorer に投げるよう主スレッドに指示する（agents 定義だけでは使われない）", () => {
    expect(DELEGATE_HINT).toContain("explorer");
    expect(DELEGATE_HINT).toContain("subagent_type");
  });

  it("確認できなかった点を確認済みとして扱わないよう促す", () => {
    expect(DELEGATE_HINT).toContain("確認済みとして扱わない");
  });
});

describe("buildSdkOptions の agents 配線", () => {
  it("隔離を有効にすると agents が載る", () => {
    const o = buildSdkOptions({ cwd: "/r", mode: "recent", isolateExploration: true });
    const agents = o.agents as Record<string, unknown> | undefined;
    expect(agents?.explorer).toBeDefined();
  });

  it("無効なら agents を載せない（既存の挙動を変えない）", () => {
    expect(buildSdkOptions({ cwd: "/r", mode: "recent" }).agents).toBeUndefined();
  });
});
