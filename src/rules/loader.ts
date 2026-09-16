/**
 * 規律 YAML の読み込みと、OKF type の導出。
 *
 * type の対応表は vault設計/manifest.yaml が正。ここに表を複製しない
 * （複製すると必ずズレる。新カテゴリ追加時に片方だけ直る事故が起きる）。
 */

import { parse as parseYaml } from "yaml";
import type { Rule, RuleSet } from "./types.js";

/** 読み込みに必要な外部操作。VSCode / fs から注入する。 */
export interface LoaderDeps {
  readFile(path: string): string | null;
  listFiles(dir: string): string[];
}

export const EMPTY_RULESET: RuleSet = { rules: [], post_run: [] };

/** 規律ディレクトリ配下の *.yaml を全部読んで統合する。 */
export function loadRules(dir: string, deps: LoaderDeps): RuleSet {
  const files = deps.listFiles(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const rules: Rule[] = [];
  const postRun: RuleSet["post_run"] = [];

  for (const file of files) {
    const raw = deps.readFile(file);
    if (raw === null) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      // 壊れた1ファイルで全規律が死ぬのは避ける。読めたものだけ使う。
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const doc = parsed as Partial<RuleSet>;
    if (Array.isArray(doc.rules)) {
      rules.push(...doc.rules.filter(isValidRule));
    }
    if (Array.isArray(doc.post_run)) {
      postRun.push(...doc.post_run);
    }
  }

  return { rules, post_run: postRun };
}

/** id と when が無いものは規律として成立しない。黙って捨てる。 */
function isValidRule(rule: unknown): rule is Rule {
  if (typeof rule !== "object" || rule === null) {
    return false;
  }
  const r = rule as Partial<Rule>;
  return typeof r.id === "string" && typeof r.when === "object" && r.when !== null;
}

/**
 * manifest.yaml のフォルダ→type 対応表を読む。
 *
 * manifest の構造に依存しすぎないよう、`type:` を持つマップを総なめして
 * 「パス断片 → type」の対を集める。
 */
export function loadTypeMap(manifestRaw: string): Array<[string, string]> {
  let doc: unknown;
  try {
    doc = parseYaml(manifestRaw);
  } catch {
    return [];
  }

  const pairs: Array<[string, string]> = [];
  const walk = (node: unknown, pathHint: string | null): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, pathHint);
      }
      return;
    }
    if (typeof node !== "object" || node === null) {
      return;
    }
    const obj = node as Record<string, unknown>;

    const p = obj.path ?? obj.dir ?? obj.folder ?? pathHint;
    const t = obj.type ?? obj.okf_type;
    if (typeof p === "string" && typeof t === "string") {
      pairs.push([p, t]);
    }

    for (const [key, value] of Object.entries(obj)) {
      // キー自体がパスらしければヒントとして引き継ぐ
      const hint = key.includes("/") ? key : pathHint;
      walk(value, hint);
    }
  };
  walk(doc, null);

  // 長いパスを先に見る（サブフォルダの type がフォルダ直下より優先されるように）
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

/** ファイルパスから type を導出する。見つからなければ null。 */
export function resolveTypeFrom(
  typeMap: Array<[string, string]>,
  filePath: string,
): string | null {
  for (const [prefix, type] of typeMap) {
    if (filePath.includes(prefix)) {
      return type;
    }
  }
  return null;
}

/**
 * フォルダ→type 対応表（manifest）の在処を決める。
 *
 * vault では `vault設計/manifest.yaml` が正だが、他のリポジトリにその名前は無い。
 * 汎用の既定を `.agent/manifest.yaml` に置き、規律 YAML と同じ場所で完結させる。
 *
 * 設定で明示指定されたのに存在しないときは、黙って候補へ落ちずに null を返す。
 * 指定ミスが「type が導出されないだけ」で表に出ないのを防ぐ。
 */
export function resolveManifestPath(
  root: string,
  configured: string | undefined,
  exists: (path: string) => boolean,
): string | null {
  const abs = (p: string): string => (p.startsWith("/") ? p : `${root}/${p}`);

  if (configured) {
    const p = abs(configured);
    return exists(p) ? p : null;
  }

  for (const candidate of [".agent/manifest.yaml", "vault設計/manifest.yaml"]) {
    const p = abs(candidate);
    if (exists(p)) {
      return p;
    }
  }
  return null;
}
