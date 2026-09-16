/**
 * 規律エンジン — ツール呼び出しを規律と突き合わせて判定する。
 *
 * 副作用（ファイル読み・コマンド実行）は注入する。VSCode API にも fs にも依存しないので
 * そのままテストできる。
 */

import type {
  Rule,
  RuleDecision,
  RuleOutcome,
  RuleSet,
  RuleWhen,
} from "./types.js";

/** エンジンが外部に依存する操作。テストでは差し替える。 */
export interface EngineDeps {
  /** ファイルの現在の内容を読む。存在しなければ null。 */
  readFile(path: string): string | null;
  /** コマンドを実行し、成功したかを返す。 */
  runCommand(command: string): { ok: boolean; output: string };
  /** フォルダパスから OKF type を導出する。導出できなければ null。 */
  resolveType(path: string): string | null;
}

/**
 * glob を正規表現にする。対応するのは `**` と `*` と `?` のみ。
 * minimatch を持ち込むほどの複雑さは要らない。
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** は / を含めて任意
        out += ".*";
        i += 2;
        if (glob[i] === "/") {
          i += 1;
        }
        continue;
      }
      // * は / をまたがない
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** ツール入力から対象ファイルパスを取り出す。 */
export function extractPath(input: Record<string, unknown>): string | null {
  const candidates = ["file_path", "notebook_path", "path"];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

/** when 条件にマッチするか。 */
export function matchesWhen(
  when: RuleWhen,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const tools = toArray(when.tool);
  if (tools.length > 0 && !tools.includes(toolName)) {
    return false;
  }

  if (when.command_pattern !== undefined) {
    const command = input.command;
    if (typeof command !== "string") {
      return false;
    }
    if (!new RegExp(when.command_pattern).test(command)) {
      return false;
    }
  }

  const pathGlobs = toArray(when.path);
  if (pathGlobs.length > 0) {
    const path = extractPath(input);
    if (path === null || !matchesAnyGlob(path, pathGlobs)) {
      return false;
    }
    const excludes = toArray(when.exclude);
    if (excludes.length > 0 && matchesAnyGlob(path, excludes)) {
      return false;
    }
  }

  return true;
}

/** frontmatter を素朴にパースする。キーの有無が分かれば足りる。 */
export function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (kv) {
      out[kv[1]] = kv[2].trim();
    }
  }
  return out;
}

/** frontmatter にキーを差し込む。既に本文がある前提。 */
export function insertFrontmatterKeys(
  content: string,
  additions: Record<string, string>,
): string {
  const entries = Object.entries(additions);
  if (entries.length === 0) {
    return content;
  }
  const lines = entries.map(([k, v]) => `${k}: ${v}`).join("\n");

  if (/^---\n[\s\S]*?\n---/.test(content)) {
    // 既存 frontmatter の先頭に足す
    return content.replace(/^---\n/, `---\n${lines}\n`);
  }
  // frontmatter が無ければ新設する
  return `---\n${lines}\n---\n\n${content}`;
}

/** frontmatter から指定キーを取り除く。 */
export function stripFrontmatterKeys(content: string, keys: string[]): string {
  const match = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!match) {
    return content;
  }
  const kept = match[2]
    .split("\n")
    .filter((line) => {
      const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):/);
      return kv === null || !keys.includes(kv[1]);
    })
    .join("\n");
  return content.replace(/^---\n[\s\S]*?\n---/, `---\n${kept}\n---`);
}

/** 1つの規律を評価する。マッチしなければ null。 */
function evaluateRule(
  rule: Rule,
  toolName: string,
  input: Record<string, unknown>,
  deps: EngineDeps,
): RuleDecision | null {
  if (!matchesWhen(rule.when, toolName, input)) {
    return null;
  }

  const path = extractPath(input);

  // when にマッチしただけで発動するもの（例: git commit は必ず ask）
  if (rule.on_match) {
    return outcomeToDecision(rule, rule.on_match, input, path, deps, {});
  }

  // require: 満たしていなければ on_missing
  if (rule.require) {
    const missing = checkRequire(rule, input, path, deps);
    if (missing !== null && rule.on_missing) {
      return outcomeToDecision(rule, rule.on_missing, input, path, deps, missing);
    }
  }

  // forbid: 触れていれば on_violation
  if (rule.forbid) {
    const violations = checkForbid(rule, input, path);
    if (violations.length > 0 && rule.on_violation) {
      return outcomeToDecision(rule, rule.on_violation, input, path, deps, {
        violations,
      });
    }
  }

  return null;
}

/** require を検査する。満たしていれば null、欠けていれば詳細を返す。 */
function checkRequire(
  rule: Rule,
  input: Record<string, unknown>,
  path: string | null,
  deps: EngineDeps,
): Record<string, unknown> | null {
  const req = rule.require!;

  if (req.command !== undefined && path !== null) {
    const cmd = req.command.replace("{file}", path);
    const result = deps.runCommand(cmd);
    if (!result.ok) {
      return { commandFailed: cmd, output: result.output };
    }
  }

  if (req.frontmatter !== undefined && req.frontmatter.length > 0) {
    const content = typeof input.content === "string" ? input.content : null;
    // Write なら content、Edit なら既存ファイルを見る
    const target = content ?? (path !== null ? deps.readFile(path) : null);
    if (target === null) {
      return null; // 中身が分からないものは判定しない
    }
    const fm = parseFrontmatter(target) ?? {};
    const missing = req.frontmatter.filter((k) => !(k in fm));
    if (missing.length > 0) {
      return { missingKeys: missing };
    }
  }

  return null;
}

/** forbid を検査する。触れている項目を返す。 */
function checkForbid(
  rule: Rule,
  input: Record<string, unknown>,
  path: string | null,
): string[] {
  const forbid = rule.forbid!;
  const found: string[] = [];

  if (forbid.filename_pattern !== undefined && path !== null) {
    const basename = path.split("/").pop() ?? "";
    if (new RegExp(forbid.filename_pattern).test(basename)) {
      found.push(`filename:${basename}`);
    }
  }

  if (forbid.frontmatter !== undefined && typeof input.content === "string") {
    const fm = parseFrontmatter(input.content);
    if (fm !== null) {
      for (const key of forbid.frontmatter) {
        if (key in fm) {
          found.push(`frontmatter:${key}`);
        }
      }
    }
  }

  return found;
}

/** RuleOutcome を実際の判定に変換する。fill / strip はここで入力を書き換える。 */
function outcomeToDecision(
  rule: Rule,
  outcome: RuleOutcome,
  input: Record<string, unknown>,
  path: string | null,
  deps: EngineDeps,
  context: Record<string, unknown>,
): RuleDecision {
  const message =
    outcome.message ?? `規律 ${rule.id}${rule.description ? `（${rule.description}）` : ""}`;

  switch (outcome.action) {
    case "deny": {
      const detail = context.output ? `\n${String(context.output)}` : "";
      return { behavior: "deny", message: message + detail, ruleId: rule.id };
    }

    case "ask":
      return { behavior: "ask", message, ruleId: rule.id };

    case "fill": {
      const content = typeof input.content === "string" ? input.content : null;
      const missingKeys = (context.missingKeys as string[] | undefined) ?? [];
      if (content === null || missingKeys.length === 0) {
        return fallbackDecision(rule, outcome, message);
      }

      const additions: Record<string, string> = {};
      for (const key of missingKeys) {
        if (key === "type" && outcome.source === "folder_map" && path !== null) {
          const resolved = deps.resolveType(path);
          if (resolved === null) {
            return fallbackDecision(rule, outcome, message);
          }
          additions[key] = resolved;
        } else if (outcome.source === "literal" && outcome.value?.[key] !== undefined) {
          additions[key] = String(outcome.value[key]);
        } else {
          return fallbackDecision(rule, outcome, message);
        }
      }

      return {
        behavior: "allow",
        updatedInput: { ...input, content: insertFrontmatterKeys(content, additions) },
        appliedRules: [rule.id],
      };
    }

    case "strip": {
      const content = typeof input.content === "string" ? input.content : null;
      if (content === null) {
        return fallbackDecision(rule, outcome, message);
      }
      const keys = (rule.forbid?.frontmatter ?? []).filter((k) =>
        ((context.violations as string[]) ?? []).includes(`frontmatter:${k}`),
      );
      if (keys.length === 0) {
        // ファイル名違反など、content の書き換えでは直せないもの
        return fallbackDecision(rule, outcome, message);
      }
      return {
        behavior: "allow",
        updatedInput: { ...input, content: stripFrontmatterKeys(content, keys) },
        appliedRules: [rule.id],
      };
    }
  }
}

function fallbackDecision(rule: Rule, outcome: RuleOutcome, message: string): RuleDecision {
  const action = outcome.fallback ?? "ask";
  if (action === "deny") {
    return { behavior: "deny", message, ruleId: rule.id };
  }
  return { behavior: "ask", message, ruleId: rule.id };
}

/**
 * 規律一式を評価する。
 *
 * deny が1つでもあれば deny。次に ask。どちらも無ければ、
 * fill/strip の updatedInput を順に重ねて allow する。
 */
export function evaluate(
  ruleSet: RuleSet,
  toolName: string,
  input: Record<string, unknown>,
  deps: EngineDeps,
): RuleDecision {
  const decisions: RuleDecision[] = [];
  for (const rule of ruleSet.rules) {
    const decision = evaluateRule(rule, toolName, input, deps);
    if (decision !== null) {
      decisions.push(decision);
    }
  }

  const denied = decisions.find((d) => d.behavior === "deny");
  if (denied) {
    return denied;
  }

  const asked = decisions.find((d) => d.behavior === "ask");
  if (asked) {
    return asked;
  }

  // allow だけ。updatedInput を順に適用する。
  let merged = input;
  const applied: string[] = [];
  for (const d of decisions) {
    if (d.behavior === "allow" && d.updatedInput) {
      merged = d.updatedInput;
      applied.push(...d.appliedRules);
    }
  }

  return applied.length > 0
    ? { behavior: "allow", updatedInput: merged, appliedRules: applied }
    : { behavior: "allow", appliedRules: [] };
}
