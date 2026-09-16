import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadRules,
  loadTypeMap,
  resolveManifestPath,
  resolveTypeFrom,
  type LoaderDeps,
} from "../src/rules/loader.js";

const VAULT = resolve(__dirname, "../../..");

function realDeps(): LoaderDeps {
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    listFiles: () => [resolve(VAULT, ".agent/rules/vault.yaml")],
  };
}

describe("loadRules", () => {
  it("実際の vault.yaml を読める", () => {
    const rs = loadRules(resolve(VAULT, ".agent/rules"), realDeps());
    expect(rs.rules.length).toBeGreaterThanOrEqual(6);
    expect(rs.rules.map((r) => r.id)).toContain("okf-type-required");
    expect(rs.post_run.length).toBeGreaterThan(0);
  });

  it("壊れた YAML があっても他は読める", () => {
    const deps: LoaderDeps = {
      readFile: (p) =>
        p.includes("broken") ? "{{{ not yaml" : "rules:\n  - id: ok\n    when:\n      tool: Write",
      listFiles: () => ["broken.yaml", "good.yaml"],
    };
    const rs = loadRules("dir", deps);
    expect(rs.rules.map((r) => r.id)).toEqual(["ok"]);
  });

  it("id や when が無い規律は捨てる", () => {
    const deps: LoaderDeps = {
      readFile: () => "rules:\n  - description: id無し\n  - id: ok\n    when: {tool: Write}",
      listFiles: () => ["a.yaml"],
    };
    expect(loadRules("dir", deps).rules).toHaveLength(1);
  });
});

// vault の実ファイルに当てる検証。拡張を vault から切り出した単独リポジトリでは
// manifest が無いのでスキップする（describe の本体で読むとファイル全体が落ちるため、
// 存在を先に確かめる）。vault 内では従来どおり全件走る。
const manifestPath = resolve(VAULT, "vault設計/manifest.yaml");
const hasVaultManifest = existsSync(manifestPath);

describe.skipIf(!hasVaultManifest)("loadTypeMap（manifest.yaml が正）", () => {
  const manifest = readFileSync(manifestPath, "utf8");
  const typeMap = loadTypeMap(manifest);

  it("実際の manifest から対応表を取れる", () => {
    expect(typeMap.length).toBeGreaterThan(5);
  });

  it("深いパスが優先される（サブフォルダが親より先）", () => {
    const t = resolveTypeFrom(
      typeMap,
      "知的基盤/ナレッジ/AIエンジニアリング/Claude Code/設定とhooks.md",
    );
    expect(t).toBe("claude-code");
  });

  it("親フォルダも解決できる", () => {
    expect(
      resolveTypeFrom(typeMap, "知的基盤/ナレッジ/AIエンジニアリング/なにか.md"),
    ).toBe("ai-engineering");
  });

  it("別カテゴリも解決できる", () => {
    expect(resolveTypeFrom(typeMap, "知的基盤/ナレッジ/アナリティクス/x.md")).toBe("analytics");
    expect(
      resolveTypeFrom(typeMap, "知的基盤/ナレッジ/ビジネス/リテールメディア/x.md"),
    ).toBe("retail-media");
  });

  it("対象外パスは null", () => {
    expect(resolveTypeFrom(typeMap, "apps/x.ts")).toBeNull();
  });
});

describe("resolveManifestPath", () => {
  /** 存在するパスの集合から existsSync 相当を作る。 */
  function existsIn(paths: string[]) {
    return (p: string) => paths.includes(p);
  }

  it("設定で明示指定されたパスを最優先で使う", () => {
    const p = resolveManifestPath("/repo", "custom/map.yaml", existsIn(["/repo/custom/map.yaml", "/repo/.agent/manifest.yaml"]));
    expect(p).toBe("/repo/custom/map.yaml");
  });

  it("明示指定が絶対パスならそのまま使う", () => {
    const p = resolveManifestPath("/repo", "/etc/map.yaml", existsIn(["/etc/map.yaml"]));
    expect(p).toBe("/etc/map.yaml");
  });

  it("明示指定されたパスが存在しなければ null（勝手に候補へ落ちない）", () => {
    const p = resolveManifestPath("/repo", "custom/map.yaml", existsIn(["/repo/.agent/manifest.yaml"]));
    expect(p).toBeNull();
  });

  it("未指定なら .agent/manifest.yaml を探す（汎用リポの既定）", () => {
    const p = resolveManifestPath("/repo", undefined, existsIn(["/repo/.agent/manifest.yaml"]));
    expect(p).toBe("/repo/.agent/manifest.yaml");
  });

  it("未指定で .agent/manifest.yaml が無ければ vault設計/manifest.yaml に落ちる", () => {
    const p = resolveManifestPath("/vault", undefined, existsIn(["/vault/vault設計/manifest.yaml"]));
    expect(p).toBe("/vault/vault設計/manifest.yaml");
  });

  it("両方あれば .agent/manifest.yaml を優先する", () => {
    const p = resolveManifestPath(
      "/vault",
      undefined,
      existsIn(["/vault/.agent/manifest.yaml", "/vault/vault設計/manifest.yaml"]),
    );
    expect(p).toBe("/vault/.agent/manifest.yaml");
  });

  it("どの候補も無ければ null（vault外のリポで落ちない）", () => {
    const p = resolveManifestPath("/other-repo", undefined, existsIn([]));
    expect(p).toBeNull();
  });
});
