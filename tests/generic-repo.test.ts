/**
 * vault 以外のリポジトリで規律が動くかの検証（P2 の受け入れ条件）。
 *
 * vault の実ファイルを一切参照せず、一時ディレクトリに .agent/ を置いて
 * loader → engine を実ファイル経由で通す。
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluate, type EngineDeps } from "../src/rules/engine.js";
import {
  EMPTY_RULESET,
  loadRules,
  loadTypeMap,
  resolveManifestPath,
  resolveTypeFrom,
  type LoaderDeps,
} from "../src/rules/loader.js";

let repo: string;

function fsDeps(): LoaderDeps {
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    listFiles: (d) => {
      try {
        return execFileSync("ls", [d], { encoding: "utf8" })
          .split("\n")
          .filter(Boolean)
          .map((f) => join(d, f));
      } catch {
        return [];
      }
    },
  };
}

/** extension.ts の buildEngineDeps と同じ組み立てを、vault に依存せず再現する。 */
function engineDeps(root: string, configured?: string): EngineDeps {
  const manifestPath = resolveManifestPath(root, configured, (p) => {
    try {
      readFileSync(p);
      return true;
    } catch {
      return false;
    }
  });
  const typeMap = manifestPath !== null ? loadTypeMap(readFileSync(manifestPath, "utf8")) : [];
  return {
    readFile: (p) => {
      try {
        return readFileSync(p.startsWith("/") ? p : join(root, p), "utf8");
      } catch {
        return null;
      }
    },
    runCommand: () => ({ ok: true, output: "" }),
    resolveType: (p) => resolveTypeFrom(typeMap, p),
  };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "generic-repo-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("vault 外のリポジトリ", () => {
  it(".agent/manifest.yaml から type を導出して fill で通す", () => {
    mkdirSync(join(repo, ".agent/rules"), { recursive: true });
    writeFileSync(
      join(repo, ".agent/manifest.yaml"),
      "zones:\n  - path: docs/adr\n    type: adr\n  - path: docs\n    type: doc\n",
    );
    writeFileSync(
      join(repo, ".agent/rules/docs.yaml"),
      [
        "rules:",
        "  - id: type-required",
        "    when:",
        "      tool: Write",
        "      path: docs/**/*.md",
        "    require:",
        "      frontmatter: [type]",
        "    on_missing:",
        "      action: fill",
        "      source: folder_map",
        "      fallback: deny",
        "",
      ].join("\n"),
    );

    const ruleSet = loadRules(join(repo, ".agent/rules"), fsDeps());
    expect(ruleSet.rules).toHaveLength(1);

    const decision = evaluate(
      ruleSet,
      "Write",
      { file_path: "docs/adr/0001.md", content: "---\ntitle: x\n---\n\n本文\n" },
      engineDeps(repo),
    );

    expect(decision.behavior).toBe("allow");
    if (decision.behavior === "allow") {
      expect(String(decision.updatedInput?.content)).toContain("type: adr");
    }
  });

  it("manifest が無いリポジトリでは fallback に落ちる（落ちずに判定を返す）", () => {
    mkdirSync(join(repo, ".agent/rules"), { recursive: true });
    writeFileSync(
      join(repo, ".agent/rules/docs.yaml"),
      [
        "rules:",
        "  - id: type-required",
        "    when:",
        "      tool: Write",
        "      path: docs/**/*.md",
        "    require:",
        "      frontmatter: [type]",
        "    on_missing:",
        "      action: fill",
        "      source: folder_map",
        "      fallback: deny",
        "",
      ].join("\n"),
    );

    const ruleSet = loadRules(join(repo, ".agent/rules"), fsDeps());
    const decision = evaluate(
      ruleSet,
      "Write",
      { file_path: "docs/x.md", content: "---\ntitle: x\n---\n" },
      engineDeps(repo),
    );

    expect(decision.behavior).toBe("deny");
  });

  it("規律ディレクトリが空なら規律ゼロで、全ツールが素通りする", () => {
    mkdirSync(join(repo, ".agent/rules"), { recursive: true });
    const ruleSet = loadRules(join(repo, ".agent/rules"), fsDeps());
    expect(ruleSet.rules).toHaveLength(0);

    const decision = evaluate(ruleSet, "Write", { file_path: "any.md" }, engineDeps(repo));
    expect(decision.behavior).toBe("allow");
  });

  it("規律ディレクトリが存在しないリポジトリでも EMPTY_RULESET で素通りする", () => {
    const decision = evaluate(EMPTY_RULESET, "Bash", { command: "ls" }, engineDeps(repo));
    expect(decision.behavior).toBe("allow");
  });

  it("設定で指定した独自パスの対応表を使える", () => {
    mkdirSync(join(repo, "config"), { recursive: true });
    writeFileSync(join(repo, "config/map.yaml"), "zones:\n  - path: notes\n    type: note\n");

    const deps = engineDeps(repo, "config/map.yaml");
    expect(deps.resolveType("notes/a.md")).toBe("note");
  });
});
