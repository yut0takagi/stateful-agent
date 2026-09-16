/**
 * 規律（rule）の型定義。
 *
 * 既存の .claude/hooks が `deny` しか持てなかったのに対し、
 * SDK の canUseTool は PermissionResult.updatedInput でツール入力を書き換えられる。
 * そのため `fill`（不足を補って通す）と `strip`（違反部分を除いて通す）を持てる。
 *
 * 例: OKF の type 欠落は「拒否して書き直させる」のではなく、
 * manifest.yaml の対応表から導出して補完し、そのまま通す。
 */

/** 規律にマッチする条件。指定した項目すべてを満たしたときにマッチする。 */
export interface RuleWhen {
  /** 対象ツール名。省略時は全ツール。 */
  tool?: string | string[];
  /** 対象パスの glob。省略時は全パス。 */
  path?: string | string[];
  /** 除外パスの glob。path にマッチしてもこれに当たれば対象外。 */
  exclude?: string | string[];
  /** Bash の command に対する正規表現。 */
  command_pattern?: string;
}

/** 満たすべき条件。 */
export interface RuleRequire {
  /** frontmatter に必須のキー。 */
  frontmatter?: string[];
  /** 実行して成功（exit 0）が必要なコマンド。{file} が対象パスに置換される。 */
  command?: string;
}

/** あってはならない条件。 */
export interface RuleForbid {
  /** frontmatter に存在してはならないキー。 */
  frontmatter?: string[];
  /** ファイル名がマッチしてはならない正規表現。 */
  filename_pattern?: string;
}

export type RuleAction = "deny" | "ask" | "fill" | "strip";

export interface RuleOutcome {
  action: RuleAction;
  /** deny / ask のときにユーザーとモデルへ返す説明。 */
  message?: string;
  /**
   * fill のとき、値をどこから導出するか。
   * folder_map = vault設計/manifest.yaml のフォルダ→type 対応表
   */
  source?: "folder_map" | "literal";
  /** source が literal のときに使う値。 */
  value?: Record<string, unknown>;
  /** 導出できなかったときの退避動作。 */
  fallback?: RuleAction;
}

export interface Rule {
  id: string;
  description?: string;
  when: RuleWhen;
  require?: RuleRequire;
  forbid?: RuleForbid;
  /** require を満たさないときの動作。 */
  on_missing?: RuleOutcome;
  /** forbid に触れたときの動作。 */
  on_violation?: RuleOutcome;
  /** when にマッチしただけで発動する動作（require/forbid なしのとき）。 */
  on_match?: RuleOutcome;
}

/** 規律エンジンの判定結果。canUseTool の PermissionResult に変換される。 */
export type RuleDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; appliedRules: string[] }
  | { behavior: "deny"; message: string; ruleId: string }
  | { behavior: "ask"; message: string; ruleId: string };

/** 実行後フック。ファイル変更を検知して後処理を走らせる。 */
export interface PostRunHook {
  when: { path_changed: string | string[] };
  run: string;
}

export interface RuleSet {
  rules: Rule[];
  post_run: PostRunHook[];
}
