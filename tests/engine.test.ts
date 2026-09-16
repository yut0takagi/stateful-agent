import { describe, expect, it } from "vitest";
import {
  evaluate,
  extractPath,
  globToRegExp,
  insertFrontmatterKeys,
  matchesWhen,
  parseFrontmatter,
  stripFrontmatterKeys,
  type EngineDeps,
} from "../src/rules/engine.js";
import type { RuleSet } from "../src/rules/types.js";

const deps: EngineDeps = {
  readFile: () => null,
  runCommand: () => ({ ok: true, output: "" }),
  resolveType: (path) => (path.includes("Claude Code") ? "claude-code" : null),
};

describe("globToRegExp", () => {
  it("** は / をまたぐ", () => {
    expect(globToRegExp("知的基盤/**/*.md").test("知的基盤/ナレッジ/AI/x.md")).toBe(true);
  });

  it("* は / をまたがない", () => {
    expect(globToRegExp("apps/*.ts").test("apps/a/b.ts")).toBe(false);
    expect(globToRegExp("apps/*.ts").test("apps/a.ts")).toBe(true);
  });

  it("メタ文字をエスケープする", () => {
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
  });
});

describe("extractPath", () => {
  it("file_path を拾う", () => {
    expect(extractPath({ file_path: "a.md" })).toBe("a.md");
  });
  it("無ければ null", () => {
    expect(extractPath({ command: "ls" })).toBeNull();
  });
});

describe("matchesWhen", () => {
  it("tool が一致しなければ外れる", () => {
    expect(matchesWhen({ tool: "Write" }, "Bash", {})).toBe(false);
  });

  it("exclude が優先される", () => {
    const when = { tool: "Write", path: "apps/**", exclude: "**/*.test.ts" };
    expect(matchesWhen(when, "Write", { file_path: "apps/a.ts" })).toBe(true);
    expect(matchesWhen(when, "Write", { file_path: "apps/a.test.ts" })).toBe(false);
  });

  it("command_pattern で Bash を絞る", () => {
    const when = { tool: "Bash", command_pattern: "^git (commit|push)" };
    expect(matchesWhen(when, "Bash", { command: "git commit -m x" })).toBe(true);
    expect(matchesWhen(when, "Bash", { command: "git status" })).toBe(false);
  });
});

describe("frontmatter 操作", () => {
  it("パースする", () => {
    expect(parseFrontmatter("---\ntype: x\ntitle: y\n---\n本文")).toEqual({
      type: "x",
      title: "y",
    });
  });

  it("frontmatter が無ければ null", () => {
    expect(parseFrontmatter("本文だけ")).toBeNull();
  });

  it("既存 frontmatter にキーを足す", () => {
    const out = insertFrontmatterKeys("---\ntitle: y\n---\n本文", { type: "x" });
    expect(out).toContain("type: x");
    expect(out).toContain("title: y");
  });

  it("frontmatter が無ければ新設する", () => {
    const out = insertFrontmatterKeys("本文", { type: "x" });
    expect(out.startsWith("---\ntype: x\n---")).toBe(true);
  });

  it("キーを取り除く", () => {
    const out = stripFrontmatterKeys("---\ntype: x\ndate: 2026-01-01\n---\n本文", ["date"]);
    expect(out).not.toContain("date:");
    expect(out).toContain("type: x");
  });
});

describe("evaluate — fill（OKF type 補完）", () => {
  const ruleSet: RuleSet = {
    rules: [
      {
        id: "okf-type-required",
        when: { tool: ["Write"], path: "知的基盤/**/*.md" },
        require: { frontmatter: ["type"] },
        on_missing: { action: "fill", source: "folder_map", fallback: "ask" },
      },
    ],
    post_run: [],
  };

  it("type が欠けていれば補って通す（拒否しない）", () => {
    const d = evaluate(
      ruleSet,
      "Write",
      {
        file_path: "知的基盤/ナレッジ/AIエンジニアリング/Claude Code/x.md",
        content: "---\ntitle: X\n---\n本文",
      },
      deps,
    );
    expect(d.behavior).toBe("allow");
    if (d.behavior === "allow") {
      expect(String(d.updatedInput?.content)).toContain("type: claude-code");
      expect(d.appliedRules).toContain("okf-type-required");
    }
  });

  it("type が既にあれば何もしない", () => {
    const d = evaluate(
      ruleSet,
      "Write",
      { file_path: "知的基盤/ナレッジ/x.md", content: "---\ntype: knowledge\n---\n本文" },
      deps,
    );
    expect(d.behavior).toBe("allow");
    if (d.behavior === "allow") {
      expect(d.appliedRules).toHaveLength(0);
    }
  });

  it("type を導出できなければ fallback で聞く", () => {
    const d = evaluate(
      ruleSet,
      "Write",
      { file_path: "知的基盤/謎フォルダ/x.md", content: "本文" },
      deps,
    );
    expect(d.behavior).toBe("ask");
  });

  it("対象外パスには効かない", () => {
    const d = evaluate(ruleSet, "Write", { file_path: "apps/x.md", content: "本文" }, deps);
    expect(d.behavior).toBe("allow");
  });
});

describe("evaluate — strip（日付キー削除）", () => {
  const ruleSet: RuleSet = {
    rules: [
      {
        id: "no-dates-in-knowledge",
        when: { tool: ["Write"], path: "知的基盤/ナレッジ/**/*.md" },
        forbid: { frontmatter: ["date", "created", "updated", "collected"] },
        on_violation: { action: "strip" },
      },
    ],
    post_run: [],
  };

  it("日付キーを落として通す", () => {
    const d = evaluate(
      ruleSet,
      "Write",
      {
        file_path: "知的基盤/ナレッジ/x.md",
        content: "---\ntype: knowledge\ncollected: 2026-09-09\n---\n本文",
      },
      deps,
    );
    expect(d.behavior).toBe("allow");
    if (d.behavior === "allow") {
      expect(String(d.updatedInput?.content)).not.toContain("collected");
      expect(String(d.updatedInput?.content)).toContain("type: knowledge");
    }
  });

  it("日付が無ければ素通り", () => {
    const d = evaluate(
      ruleSet,
      "Write",
      { file_path: "知的基盤/ナレッジ/x.md", content: "---\ntype: knowledge\n---\n本文" },
      deps,
    );
    if (d.behavior === "allow") {
      expect(d.appliedRules).toHaveLength(0);
    }
  });
});

describe("evaluate — deny / ask", () => {
  it("テストが赤ければ拒否する", () => {
    const ruleSet: RuleSet = {
      rules: [
        {
          id: "test-green-required",
          when: { tool: ["Edit"], path: "apps/**" },
          require: { command: "check.sh {file}" },
          on_missing: { action: "deny", message: "テストが赤い" },
        },
      ],
      post_run: [],
    };
    const failing: EngineDeps = {
      ...deps,
      runCommand: () => ({ ok: false, output: "2 failed" }),
    };
    const d = evaluate(ruleSet, "Edit", { file_path: "apps/x.ts" }, failing);
    expect(d.behavior).toBe("deny");
    if (d.behavior === "deny") {
      expect(d.message).toContain("テストが赤い");
      expect(d.message).toContain("2 failed");
    }
  });

  it("git commit は必ず承認を挟む", () => {
    const ruleSet: RuleSet = {
      rules: [
        {
          id: "confirm-side-effects",
          when: { tool: "Bash", command_pattern: "^git (commit|push)" },
          on_match: { action: "ask", message: "副作用の確認" },
        },
      ],
      post_run: [],
    };
    expect(evaluate(ruleSet, "Bash", { command: "git commit -m x" }, deps).behavior).toBe("ask");
    expect(evaluate(ruleSet, "Bash", { command: "git status" }, deps).behavior).toBe("allow");
  });

  it("deny は ask より優先される", () => {
    const ruleSet: RuleSet = {
      rules: [
        {
          id: "asker",
          when: { tool: "Bash" },
          on_match: { action: "ask", message: "ask" },
        },
        {
          id: "denier",
          when: { tool: "Bash" },
          on_match: { action: "deny", message: "deny" },
        },
      ],
      post_run: [],
    };
    const d = evaluate(ruleSet, "Bash", { command: "x" }, deps);
    expect(d.behavior).toBe("deny");
  });
});
