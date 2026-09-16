/**
 * Agent SDK の呼び出しと履歴モードの制御。
 *
 * ここが「履歴を持たない」の実体。SDK の query() は入力が prompt と options だけで、
 * messages 配列を渡す口がない。つまり resume を指定しなければ履歴ゼロで始まる。
 * 履歴を持たせるほうが明示的な操作になっている。
 *
 * 認証は claude.ai OAuth（サブスク）をそのまま使う。API キーは要らない。
 * 型に subscription_type / apiKeySource:'none' があり、SDK 側が正規に対応している。
 */

// SDK は ESM。CommonJS から型だけ借りるので resolution-mode を明示する。
import type { query as QueryFn } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import {
  applyPatch,
  buildPrompt,
  extractPatch,
  validatePatch,
  type AgentState,
  type HistoryMode,
} from "./state.js";
import { TurnBudget, type BudgetReport } from "./toolbudget.js";

/**
 * SDK は ESM 専用だが VSCode 拡張は CommonJS で動く。
 * 静的 import は require に落ちて壊れるので、動的 import で読む。
 * esbuild が変換してしまわないよう Function 経由にする。
 */
const importSdk = new Function(
  'return import("@anthropic-ai/claude-agent-sdk")',
) as () => Promise<{ query: typeof QueryFn }>;

/** 1ターンの記録。recent モードで直近N件だけ持ち回る。 */
export interface Turn {
  instruction: string;
  response: string;
}

export interface RunOptions {
  state: AgentState;
  instruction: string;
  mode: HistoryMode;
  /** recent モードで保持するターン数。 */
  recentTurns: number;
  /** これまでのターン（新しいものが末尾）。 */
  history: Turn[];
  cwd: string;
  /** full モードで継続するセッション ID。他モードでは使わない。 */
  sessionId?: string;
  canUseTool?: NonNullable<Parameters<typeof QueryFn>[0]["options"]>["canUseTool"];
  abortController?: AbortController;
  /** ストリーミング中のテキストを逐次受け取る。 */
  onText?: (chunk: string) => void;
  /** ツール呼び出しを受け取る（チャットにカードとして埋め込むため）。 */
  onToolUse?: (id: string, name: string, input: Record<string, unknown>) => void;
  /** ツール結果を受け取る。 */
  onToolResult?: (id: string, content: string, isError: boolean) => void;
  /**
   * ツール出力に予算をかける。省略すると従来どおり全量が流れる。
   * 呼び出し側がターンごとに作り直す（持ち回すと予算が枯れたまま次ターンに入る）。
   */
  budget?: TurnBudget;
}

export interface RunResult {
  response: string;
  /** 応答から取り出した state パッチを適用した結果。 */
  state: AgentState;
  sessionId?: string;
  usage?: TurnUsage;
  rateLimit?: unknown;
  /** state が引き継ぎ書として成立していない点。保存は通したうえで人に見せる。 */
  stateWarnings: string[];
  /** ツール出力をどれだけ削ったか。budget を渡したときだけ入る。 */
  budgetReport?: BudgetReport;
}

/**
 * モードに応じて履歴を切り出す。
 *
 * stateless: 何も渡さない（論文どおり）
 * recent:    直近 N ターンだけ
 * full:      ここでは渡さず、SDK の resume に任せる
 */
export function selectHistory(mode: HistoryMode, history: Turn[], n: number): string[] {
  if (mode === "stateless" || mode === "full") {
    return [];
  }
  // slice(-0) は slice(0) と同じで全件返る。N=0 は「履歴なし」の意思表示なので先に弾く。
  if (n <= 0) {
    return [];
  }
  const recent = history.slice(-n);
  return recent.flatMap((t) => [`- 指示: ${t.instruction}`, `  応答: ${summarize(t.response)}`]);
}

/** tool_result の content は文字列にも配列にもなる。表示用に文字列へ寄せる。 */
function stringifyResult(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const b = c as { type?: string; text?: string };
        return b.type === "text" && typeof b.text === "string" ? b.text : "";
      })
      .filter((x) => x !== "")
      .join("\n");
  }
  return "";
}

/** 履歴に載せる応答は要約する。全文を持つと結局履歴が伸びる。 */
function summarize(text: string, limit = 300): string {
  const oneLine = text.replace(/```[\s\S]*?```/g, "[コードブロック]").replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? oneLine.slice(0, limit) + "…" : oneLine;
}

/**
 * state パッチの規約をシステムプロンプト側に置く。
 *
 * ユーザープロンプト末尾（buildPrompt）に書くだけでは守られない。
 * SDK 既定のシステムプロンプト（claude_code preset）は state 規約を知らないので、
 * モデルは通常の応答を返して終わる。preset に append して指示を常設する。
 */
export const STATE_PROTOCOL = [
  "# 作業 state の更新（この環境の規約）",
  "",
  "この環境では会話履歴を持たない。次のターンのあなたは、いまのやり取りを一切覚えていない。",
  "読めるのは state だけ。**state に書かれていないことは失われる。**",
  "",
  "だから state は作業日誌ではない。**subagent に作業を委譲するときの引き継ぎ書**として書く。",
  "引き継がれた側が state だけを読んで、方針を再検討しながら作業を続けられること。それが基準。",
  "",
  "state はもう一つの役目を持つ。**どの判断が、どの情報と、どの過去の判断に影響されたか**を",
  "後から辿れる記録になること。だから決定には id を振り、前の決定を踏まえたなら依存として指す。",
  "",
  "## 出力形式",
  "",
  "応答の最後に次を出す。",
  "",
  "```state",
  "{",
  '  "目的": "いま何を達成しようとしているか（1文）",',
  '  "決定": [',
  "    {",
  '      "id": "D1",',
  '      "何を": "決めた内容",',
  '      "依存": ["D0"],',
  '      "前提": ["その判断が依存している事実・制約"],',
  '      "却下": "採らなかった案とその理由",',
  '      "行動": "実際に何をしたか",',
  '      "検証": "正しいと確認した方法（未確認なら未確認と書く）",',
  '      "状態": "確定"',
  "    }",
  "  ],",
  '  "未決": [{ "論点": "決まっていないこと", "要る情報": "決めるために必要なもの" }],',
  '  "次の一手": "引き継いだ側が最初にやること"',
  "}",
  "```",
  "",
  "## 決定レコードの規則",
  "",
  "- **「何を」と「行動」は必須。** どちらか欠けると何が起きたのか復元できない",
  "- **「id」を必ず振る。** `D1` `D2` … と通し番号でよい。",
  "  **必ず state の既存の決定を見て、その続きから振ること。**",
  "  最後が `D7` なら次は `D8`。`D1` に戻すと別物が同じ id を持ち、",
  "  どの決定を指しているのか追えなくなる（実際に D6 と D7 が重複した）",
  "- **過去の決定を踏まえた判断なら「依存」にその id を書く。**",
  "  これがないと、判断の連鎖が切れて「なぜこの方針なのか」が辿れなくなる。",
  "  逆に、独立した判断に依存を書かない（線を捏造しない）",
  "- **「前提」か「却下」のどちらかは必須。** 理由のない決定は引き継いだ側が再検討できず、",
  "  「先人が決めたから」で固定されてしまう。なぜその道を選んだかを必ず残す",
  "- **「前提」には事実と制約を書く。** 感想や意気込みではない。",
  "  後でその前提が崩れたときに、どの決定を見直すべきかが分かる形にする",
  "- **「却下」は検討した代替案。** 何も検討していないなら省いてよいが、",
  "  比較したなら必ず残す（同じ検討を次のターンで繰り返させない）",
  "- **「検証」は確認した手段。** テストを通した / 実データで確かめた / 未確認 のどれか。",
  "  確認していないことを確認したように書かない",
  "- **「状態」は 確定 / 暫定 / 撤回 のいずれか。** 暫定は覆してよい決定、",
  "  確定は覆すなら理由が要る決定。撤回は誤りだったと分かったもの（消さずに残す — ",
  "  同じ間違いを繰り返さないため）",
  "",
  "## やってはいけない書き方",
  "",
  "- やったことの羅列（`\"やったこと\": [\"実装した\", \"テストした\"]`）",
  "  → 何を判断したのかが無く、引き継いだ側は経緯を再構成できない",
  "- 前提を書かずに結論だけ置く → なぜそうなっているか不明な制約として残る",
  "- 事実と推測を混ぜる → 推測は「未決」の論点に回す",
  "- 失敗した決定を黙って消す → 状態を「撤回」にして理由を残す",
  "",
  "## 更新の作法",
  "",
  "**既存の決定を書き直さない。** 変わった分だけ出す。",
  "配列を丸ごと書き直すと、同じ内容を毎ターン再出力することになる。",
  "",
  "| 書き方 | 意味 |",
  "|---|---|",
  "| `決定+` | 新しい決定を**追記**する（既存には触れない）",
  "| `決定~` | `id` が一致する決定を**差し替える**（状態を変える・撤回する）",
  "| `決定` | 配列を**全置換**する。作り直すとき以外は使わない",
  "",
  "```state",
  '{ "決定+": [{ "id": "D8", "何を": "...", "前提": ["..."], "行動": "...", "状態": "確定" }] }',
  "```",
  "",
  "同じ規約が `未決+` `未決~` にも使える。",
  "`目的` や `次の一手` のような単一の値は、これまでどおりキーごと上書きする。",
  "",
  "- 値に `null` を書くとそのキーは削除される",
  "- 作業が進んだ・何かを判断した・次にやることが変わった、のいずれかがあれば必ず出す",
  "- 判断を1つもしていないターン（単なる確認・報告）では省略してよい",
].join("\n");

export interface SdkOptionInput {
  cwd: string;
  mode: HistoryMode;
  sessionId?: string;
  canUseTool?: RunOptions["canUseTool"];
  abortController?: AbortController;
  /**
   * ツール出力の予算。渡すと PostToolUse フックでモデルに届く前に削る。
   * 省略すると従来どおり全量が流れる（既存の挙動を変えない）。
   */
  budget?: TurnBudget;
}

/**
 * ツール出力を削る PostToolUse フックを組み立てる。
 *
 * `updatedToolOutput` は「Replaces the tool output before it is sent to the model」。
 * ここが実測で効く唯一の口だった（履歴を切る操作は inputTokens にしか効かず、
 * それはコストの 0.0% しか占めていない）。
 *
 * 削る必要がないときは hookSpecificOutput を返さない。空の差し替えを返すと
 * 並行して走る他フックの差し替えと last-write-wins で競合し、
 * 本物の削減を打ち消す可能性がある（SDK の型注記が明示している）。
 */
export function buildPostToolUseHook(budget: TurnBudget) {
  return async (input: unknown): Promise<Record<string, unknown>> => {
    const i = input as { tool_name?: string; tool_response?: unknown };
    if (typeof i.tool_name !== "string") {
      return {};
    }
    const replaced = budget.apply(i.tool_name, i.tool_response);
    if (replaced === null) {
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: replaced,
      },
    };
  };
}

/**
 * SDK に渡す options を組み立てる。
 *
 * resume は full モードのときだけ渡す。他モードで渡すと履歴が復活して
 * 「履歴を持たない」という前提そのものが崩れる。
 */
export function buildSdkOptions(input: SdkOptionInput): Record<string, unknown> {
  return {
    cwd: input.cwd,
    ...(input.budget
      ? {
          hooks: {
            PostToolUse: [{ hooks: [buildPostToolUseHook(input.budget)] }],
          },
        }
      : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: STATE_PROTOCOL,
      // 作業ディレクトリ・auto-memory・git status を外してプロンプトを静的にする。
      // これらは毎回変わるのでキャッシュの prefix が一致せず、全ミスしていた。
      // 外した内容は最初のユーザーメッセージに再注入されるので、モデルは参照できる。
      excludeDynamicSections: true,
      // プロンプトを1度記録して以降そのまま使う。途中で変わると prefix が無効になる。
      snapshot: true,
    },
    // これが無いと assistant メッセージが完成後に一括で届く（= 画面が固まる）。
    includePartialMessages: true,
    ...(input.mode === "full" && input.sessionId ? { resume: input.sessionId } : {}),
    ...(input.canUseTool ? { canUseTool: input.canUseTool } : {}),
    ...(input.abortController ? { abortController: input.abortController } : {}),
  };
}

/**
 * stream_event から本文のテキスト差分だけ取り出す。
 *
 * thinking_delta は本文ではないので載せない（出すと state フェンスの前に
 * 思考が混ざって表示が壊れる）。空文字は再描画の無駄なので弾く。
 */
export function extractStreamText(event: unknown): string | null {
  if (typeof event !== "object" || event === null) {
    return null;
  }
  const e = event as { type?: string; delta?: { type?: string; text?: string } };
  if (e.type !== "content_block_delta") {
    return null;
  }
  if (e.delta?.type !== "text_delta") {
    return null;
  }
  const text = e.delta.text;
  return typeof text === "string" && text !== "" ? text : null;
}

export interface PatchResult {
  state: AgentState;
  /** パッチが実際に適用されたか。false なら state 据え置き。 */
  patched: boolean;
  /** 引き継ぎ書として足りない点。空なら問題なし。 */
  warnings: string[];
}

/**
 * 応答から state パッチを取り出し、検証して適用する。
 *
 * 検証に落ちても**適用する**。拒否すると、形式を外した瞬間に state が
 * 一切更新されなくなり「質が低い」より悪い「何も残らない」に転ぶ。
 * 警告は呼び出し側が人に見せる。
 */
export function processPatch(state: AgentState, response: string): PatchResult {
  const patch = extractPatch(response);
  if (patch === null) {
    return { state, patched: false, warnings: [] };
  }
  return {
    state: applyPatch(state, patch),
    patched: true,
    warnings: validatePatch(patch),
  };
}

/** 1ターンの消費。キャッシュの効きを見るため cache 系も持つ。 */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  /** キャッシュから読めたトークン。多いほど効いている。 */
  cacheReadTokens: number;
  /** キャッシュに書いたトークン。毎ターン書いて読めていないなら無駄になっている。 */
  cacheCreationTokens: number;
  costUSD?: number;
}

/**
 * SDK の usage からトークン数を取り出す。
 *
 * cache 系を拾うのは「キャッシュが引き継がれているか」を測るため。
 * resume を渡さないモードではセッションが毎ターン新しくなるので、
 * cacheRead が 0 のままなら全ミスしていると分かる。
 * 欄が無いターンも 0 として残す（測れなかったことを隠すと分母がずれる）。
 */
export function extractUsage(
  raw: Record<string, number> | undefined,
  costUSD?: number,
): TurnUsage {
  return {
    inputTokens: raw?.input_tokens ?? 0,
    outputTokens: raw?.output_tokens ?? 0,
    cacheReadTokens: raw?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: raw?.cache_creation_input_tokens ?? 0,
    ...(costUSD !== undefined ? { costUSD } : {}),
  };
}

/** SDK を1ターン実行する。 */
export async function run(opts: RunOptions): Promise<RunResult> {
  const recent = selectHistory(opts.mode, opts.history, opts.recentTurns);
  const prompt = buildPrompt(opts.state, opts.instruction, recent);

  const sdkOptions = buildSdkOptions({
    cwd: opts.cwd,
    mode: opts.mode,
    sessionId: opts.sessionId,
    canUseTool: opts.canUseTool,
    abortController: opts.abortController,
    budget: opts.budget,
  });

  let response = "";
  let sessionId: string | undefined;
  let usage: RunResult["usage"];
  let rateLimit: unknown;

  const { query } = await importSdk();

  for await (const message of query({ prompt, options: sdkOptions as never })) {
    const m = message as Record<string, unknown>;

    if (m.type === "system" && m.subtype === "init") {
      sessionId = m.session_id as string | undefined;
      continue;
    }

    // ストリーミング中の差分。表示はこちらが担う。
    if (m.type === "stream_event") {
      const chunk = extractStreamText(m.event);
      if (chunk !== null) {
        opts.onText?.(chunk);
      }
      continue;
    }

    if (m.type === "assistant") {
      const content = (m.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const block of content) {
        const b = block as { type?: string; text?: string };
        // 確定した本文を response に積む。表示は stream_event が済ませているので
        // ここで onText は呼ばない（呼ぶと同じ文が二重に出る）。
        if (b.type === "text" && typeof b.text === "string") {
          response += b.text;
        }
        if (b.type === "tool_use") {
          const t = block as { id?: string; name?: string; input?: unknown };
          if (typeof t.id === "string" && typeof t.name === "string") {
            opts.onToolUse?.(t.id, t.name, (t.input as Record<string, unknown>) ?? {});
          }
        }
      }
      continue;
    }

    // ツール結果は user ロールで返ってくる。
    if (m.type === "user") {
      const content = (m.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as {
            type?: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          };
          if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            opts.onToolResult?.(b.tool_use_id, stringifyResult(b.content), b.is_error === true);
          }
        }
      }
      continue;
    }

    if (m.type === "rate_limit_event") {
      rateLimit = m.rate_limit_info;
      continue;
    }

    if (m.type === "result") {
      usage = extractUsage(
        m.usage as Record<string, number> | undefined,
        m.total_cost_usd as number | undefined,
      );
    }
  }

  const patched = processPatch(opts.state, response);

  return {
    response,
    state: patched.state,
    sessionId,
    usage,
    rateLimit,
    stateWarnings: patched.warnings,
    ...(opts.budget ? { budgetReport: opts.budget.report() } : {}),
  };
}
