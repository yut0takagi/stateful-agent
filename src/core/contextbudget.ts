/**
 * context 予算 — 3つの介入点を1本のパイプラインとして束ねる層。
 *
 * ## なぜこの層が要るか
 *
 * 削減の手は3つあり、**互いに排他ではなく直列**である。
 * 同じツール呼び出しが3つの関門を順に通る。
 *
 * ```
 *  指示 ─┬─[1] 隔離?  ── 調査なら explorer に投げる（出力が主文脈に入らない）
 *        │              options.agents / agent.ts
 *        ▼
 *  ツール呼び出し
 *        ├─[2] 入力を絞る ── Read に範囲を足す / Bash を head で包む
 *        │                  canUseTool / readplan.ts
 *        ▼
 *     ツール実行
 *        ├─[3] 出力を削る ── 返ってきた出力を中略する
 *        │                  PostToolUse / toolbudget.ts
 *        ▼
 *     モデルに届く
 * ```
 *
 * 3つを別々の設定として置くと、どれが効いたのか分離できない。
 * **[2] が絞った上に [3] がさらに削ると、削減量を二重に数えてしまう。**
 * だからこの層が層ごとの実績を分けて持ち、合算のときに重複を除く。
 *
 * ## 実測の根拠
 *
 * 12ターン × 3モード（`.bench/turns.jsonl`）:
 *
 * | モード | $/turn | in | cacheCreate | cacheRead | out |
 * |---|---|---|---|---|---|
 * | stateless | 1.025 | **0.0%** | 45.9% | 28.2% | 26.0% |
 * | recent | 0.886 | **0.0%** | 46.5% | 24.7% | 28.8% |
 * | full | **0.613** | **0.0%** | 23.2% | 38.2% | 38.6% |
 *
 * 履歴を切る操作は `inputTokens` にしか効かず、そこはコストの 0.0%。
 * 動いているのは `cacheCreate` + `cacheRead`（6〜7割）で、これはラリー内部で
 * ツール出力が prefix に積まれ、各ステップで読み直されているぶんである。
 *
 * この層は SDK にも VSCode にも fs にも依存しない。会計と判断だけを持つ。
 */

import { planBash, planRead, DEFAULT_READ_LIMITS, type FileFacts, type ReadPlanLimits } from "./readplan.js";
import { TurnBudget, DEFAULT_LIMITS, type BudgetLimits, type BudgetReport } from "./toolbudget.js";
import { shouldDelegate } from "./explorer.js";

/** どの層を有効にするか。全て既定で有効。 */
export interface LayerSwitches {
  /** [1] 調査を explorer に隔離する。 */
  isolate: boolean;
  /** [2] ツール入力を絞る（Read に範囲・Bash に head）。 */
  narrowInput: boolean;
  /** [3] ツール出力を中略する。 */
  trimOutput: boolean;
}

export const ALL_LAYERS: LayerSwitches = {
  isolate: true,
  narrowInput: true,
  trimOutput: true,
};

export interface ContextBudgetConfig {
  layers: LayerSwitches;
  read: ReadPlanLimits;
  output: BudgetLimits;
  /** Bash に足す head の行数。 */
  bashOutputLines: number;
}

export const DEFAULT_CONFIG: ContextBudgetConfig = {
  layers: ALL_LAYERS,
  read: DEFAULT_READ_LIMITS,
  output: DEFAULT_LIMITS,
  bashOutputLines: 200,
};

/** 層ごとの実績。どの関門が効いたかを分けて持つ。 */
export interface LayerLedger {
  /** [1] 調査を隔離したか。 */
  isolated: boolean;
  /** [2] 入力を絞った回数。 */
  narrowedCalls: number;
  /** [3] 出力を中略した回数と削った文字数。 */
  outputReport?: BudgetReport;
}

/**
 * 1ターンの context 予算。ターンごとに作り直す。
 *
 * 持ち回すと予算が枯れたまま次ターンに入る。
 */
export class ContextBudget {
  private readonly output: TurnBudget | null;
  private isolated = false;
  private readonly narrowed: NarrowRecord[] = [];

  constructor(private readonly cfg: ContextBudgetConfig = DEFAULT_CONFIG) {
    this.output = cfg.layers.trimOutput ? new TurnBudget(cfg.output) : null;
  }

  /** [1] この指示で調査を隔離するか。 */
  planIsolation(instruction: string): boolean {
    if (!this.cfg.layers.isolate) {
      return false;
    }
    this.isolated = shouldDelegate(instruction);
    return this.isolated;
  }

  /**
   * [2] ツール入力を絞る。絞らないなら null。
   *
   * `facts` はファイルの行数・バイト数を返す関数。fs に依存させないため注入する。
   */
  planInput(
    toolName: string,
    input: Record<string, unknown>,
    facts: (path: string) => FileFacts,
  ): { updatedInput: Record<string, unknown>; reason: string } | null {
    if (!this.cfg.layers.narrowInput) {
      return null;
    }

    if (toolName === "Read") {
      const fp = input.file_path;
      if (typeof fp !== "string") {
        return null;
      }
      const d = planRead(input, facts(fp), this.cfg.read);
      if (d.kind !== "narrow") {
        return null;
      }
      this.narrowed.push({ tool: toolName, reason: d.reason });
      return { updatedInput: d.updatedInput, reason: d.reason };
    }

    if (toolName === "Bash") {
      const cmd = input.command;
      if (typeof cmd !== "string") {
        return null;
      }
      const d = planBash(cmd, this.cfg.bashOutputLines);
      if (d.kind !== "narrow") {
        return null;
      }
      this.narrowed.push({ tool: toolName, reason: d.reason });
      return { updatedInput: { ...input, command: d.command }, reason: d.reason };
    }

    return null;
  }

  /**
   * [3] ツール出力を削る。削らないなら null。
   *
   * [2] で絞った結果に対してかかる。つまり二段目である。
   * 二重に数えないよう、削減量は層ごとに分けて記録する（report を参照）。
   */
  applyOutput(toolName: string, response: unknown): string | null {
    return this.output?.apply(toolName, response) ?? null;
  }

  /** 層ごとの実績。 */
  ledger(): LayerLedger {
    return {
      isolated: this.isolated,
      narrowedCalls: this.narrowed.length,
      ...(this.output ? { outputReport: this.output.report() } : {}),
    };
  }

  /**
   * 人に見せる1行。効き目が見えないと閾値を動かせない。
   *
   * **層をまたいで合算した削減率は出さない。** [2] が絞った後の出力に [3] が
   * かかるので、両者の「削った文字数」を足すと元の量を二重に数えることになる
   * （元 10,000 文字 → [2] で 4,000 に絞る → [3] が 3,000 に削る、を
   * 「6,000 + 1,000 = 7,000 削減」と読むのは誤り。実際の削減は 7,000 だが
   * 分母が違うので率にできない）。層ごとに別々に出す。
   */
  summary(): string | null {
    const l = this.ledger();
    const parts: string[] = [];

    if (l.isolated) {
      parts.push("調査を explorer に隔離");
    }
    if (l.narrowedCalls > 0) {
      parts.push(`入力を ${l.narrowedCalls} 件で絞り込み`);
    }
    const r = l.outputReport;
    if (r && r.trimmedCalls > 0) {
      const pct = Math.round((r.savedChars / r.totalOriginalChars) * 100);
      parts.push(
        `出力 ${r.trimmedCalls}/${r.calls} 件を中略（${r.totalOriginalChars.toLocaleString()}→${r.totalKeptChars.toLocaleString()} 文字 -${pct}%）`,
      );
    }

    return parts.length > 0 ? parts.join(" / ") : null;
  }
}

interface NarrowRecord {
  tool: string;
  reason: string;
}
