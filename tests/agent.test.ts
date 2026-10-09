import { describe, expect, it } from "vitest";
import {
  buildSdkOptions,
  extractStreamText,
  extractUsage,
  processPatch,
  selectHistory,
  type Turn,
} from "../src/core/agent.js";

const turns: Turn[] = [
  { instruction: "1つ目", response: "応答1" },
  { instruction: "2つ目", response: "応答2" },
  { instruction: "3つ目", response: "応答3" },
];

describe("selectHistory", () => {
  it("stateless は履歴を渡さない", () => {
    expect(selectHistory("stateless", turns, 3)).toEqual([]);
  });

  it("full は履歴を渡さない（SDK の resume に任せる）", () => {
    expect(selectHistory("full", turns, 3)).toEqual([]);
  });

  it("recent は直近 N ターンだけ渡す", () => {
    const lines = selectHistory("recent", turns, 2);
    expect(lines.join("\n")).toContain("2つ目");
    expect(lines.join("\n")).toContain("3つ目");
    expect(lines.join("\n")).not.toContain("1つ目");
  });

  it("recent で N=0 なら空", () => {
    expect(selectHistory("recent", turns, 0)).toEqual([]);
  });
});

describe("buildSdkOptions", () => {
  it("state パッチの規約をシステムプロンプトに載せる", () => {
    const o = buildSdkOptions({ cwd: "/repo", mode: "stateless" });
    const sp = o.systemPrompt as { type: string; preset: string; append?: string };
    expect(sp.type).toBe("preset");
    expect(sp.preset).toBe("claude_code");
    expect(sp.append).toContain("```state");
  });

  it("ストリーミングを有効にする", () => {
    const o = buildSdkOptions({ cwd: "/repo", mode: "stateless" });
    expect(o.includePartialMessages).toBe(true);
  });

  it("cwd をそのまま渡す", () => {
    expect(buildSdkOptions({ cwd: "/repo", mode: "stateless" }).cwd).toBe("/repo");
  });

  it("full モードで sessionId があれば resume する", () => {
    const o = buildSdkOptions({ cwd: "/repo", mode: "full", sessionId: "abc" });
    expect(o.resume).toBe("abc");
  });

  it("stateless では sessionId があっても resume しない（履歴ゼロを守る）", () => {
    const o = buildSdkOptions({ cwd: "/repo", mode: "stateless", sessionId: "abc" });
    expect(o.resume).toBeUndefined();
  });

  it("recent でも resume しない", () => {
    const o = buildSdkOptions({ cwd: "/repo", mode: "recent", sessionId: "abc" });
    expect(o.resume).toBeUndefined();
  });

  it("full でも sessionId が無ければ resume しない", () => {
    const o = buildSdkOptions({ cwd: "/repo", mode: "full" });
    expect(o.resume).toBeUndefined();
  });

  it("replayUserMessages で --replay-user-messages を付ける。既定では付けない", () => {
    expect(buildSdkOptions({ cwd: "/repo", mode: "stateless", replayUserMessages: true }).extraArgs).toEqual({
      "replay-user-messages": null,
    });
    expect(buildSdkOptions({ cwd: "/repo", mode: "stateless" }).extraArgs).toBeUndefined();
  });
});

describe("extractStreamText", () => {
  it("content_block_delta の text_delta を取り出す", () => {
    const t = extractStreamText({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "こん" },
    });
    expect(t).toBe("こん");
  });

  it("thinking_delta は本文ではないので無視する", () => {
    const t = extractStreamText({
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "考え中" },
    });
    expect(t).toBeNull();
  });

  it("message_start など delta を持たないイベントは無視する", () => {
    expect(extractStreamText({ type: "message_start" })).toBeNull();
  });

  it("空文字の delta は無視する（無駄な再描画を防ぐ）", () => {
    const t = extractStreamText({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "" },
    });
    expect(t).toBeNull();
  });

  it("形が違うものを渡しても落ちない", () => {
    expect(extractStreamText(null)).toBeNull();
    expect(extractStreamText(undefined)).toBeNull();
    expect(extractStreamText("文字列")).toBeNull();
  });
});

describe("processPatch", () => {
  const base = { schema_version: 1, active: false } as const;

  it("パッチが無ければ state 据え置き・警告なし", () => {
    const r = processPatch(base, "state を出さない応答");
    expect(r.state).toEqual(base);
    expect(r.warnings).toEqual([]);
    expect(r.patched).toBe(false);
  });

  it("台帳型のパッチを適用する", () => {
    const response = [
      "作業した。",
      "```state",
      JSON.stringify({
        決定: [
          { 何を: "3段探索", 前提: ["vaultのみ独自パス"], 行動: "実装", 検証: "テスト", 状態: "確定" },
        ],
      }),
      "```",
    ].join("\n");
    const r = processPatch(base, response);
    expect(r.patched).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(Array.isArray(r.state["決定"])).toBe(true);
  });

  it("やったことの羅列には警告を付けるが、保存は通す", () => {
    const response = ["```state", JSON.stringify({ やったこと: ["実装した"] }), "```"].join("\n");
    const r = processPatch(base, response);
    expect(r.patched).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/決定/);
    expect(r.state["やったこと"]).toEqual(["実装した"]);
  });

  it("理由のない決定に警告を付ける", () => {
    const response = [
      "```state",
      JSON.stringify({ 決定: [{ 何を: "x", 行動: "y" }] }),
      "```",
    ].join("\n");
    const r = processPatch(base, response);
    expect(r.warnings.join("\n")).toMatch(/前提/);
  });

  it("壊れた state フェンスは据え置きにする", () => {
    const r = processPatch(base, "```state\n{ 壊れてる\n```");
    expect(r.patched).toBe(false);
    expect(r.state).toEqual(base);
  });
});

describe("extractUsage — キャッシュの効きを測れるようにする", () => {
  it("キャッシュ読み込み・作成のトークンを拾う", () => {
    const u = extractUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 200,
    });
    expect(u.cacheReadTokens).toBe(8000);
    expect(u.cacheCreationTokens).toBe(200);
  });

  it("キャッシュ欄が無いターンは 0 として扱う（測れなかったことを残す）", () => {
    const u = extractUsage({ input_tokens: 100, output_tokens: 50 });
    expect(u.cacheReadTokens).toBe(0);
    expect(u.cacheCreationTokens).toBe(0);
  });

  it("入出力トークンも拾う", () => {
    const u = extractUsage({ input_tokens: 100, output_tokens: 50 });
    expect(u.inputTokens).toBe(100);
    expect(u.outputTokens).toBe(50);
  });

  it("usage が空でも落ちない", () => {
    const u = extractUsage(undefined);
    expect(u.inputTokens).toBe(0);
    expect(u.cacheReadTokens).toBe(0);
  });
});

describe("キャッシュを跨いで効かせる設定", () => {
  it("動的セクションを外してシステムプロンプトを静的にする", () => {
    const o = buildSdkOptions({ cwd: "/repo", mode: "stateless" });
    const sp = o.systemPrompt as { excludeDynamicSections?: boolean };
    // 作業ディレクトリ・git status が毎回変わると prefix が一致せずキャッシュが全ミスする
    expect(sp.excludeDynamicSections).toBe(true);
  });

  it("システムプロンプトを記録して再利用する", () => {
    const o = buildSdkOptions({ cwd: "/repo", mode: "stateless" });
    const sp = o.systemPrompt as { snapshot?: boolean };
    expect(sp.snapshot).toBe(true);
  });

  it("state 規約は append に残る（静的なので prefix に載る）", () => {
    const o = buildSdkOptions({ cwd: "/repo", mode: "stateless" });
    const sp = o.systemPrompt as { append?: string };
    expect(sp.append).toContain("```state");
  });

  it("履歴モードを変えてもシステムプロンプトは同一（prefix を揺らさない）", () => {
    const a = buildSdkOptions({ cwd: "/repo", mode: "stateless" }).systemPrompt;
    const b = buildSdkOptions({ cwd: "/repo", mode: "recent" }).systemPrompt;
    expect(a).toEqual(b);
  });
});
