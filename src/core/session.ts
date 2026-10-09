/**
 * ターンのあとも CLI を残すセッション。
 *
 * run()（agent.ts）はプロンプトを文字列で渡すので、SDK が最初の result で stdin を閉じ、CLI もそこで止まる。
 * ところが mod は、ターンのあとで $.prompt.submit() を呼んで続きのターンを始めることがある。
 * push-gate は、拒否したあとで帯の「承認」が押されたら、同じコマンドの実行を頼むプロンプトを積む。
 * それを受けるため、ここではプロンプトを AsyncIterable で渡し、閉じるまで stdin を開けておく
 * （SDK は入力が終わるまで stdin を閉じない）。
 *
 * 1 セッションは「人の指示 1 つ」と「そのあと CLI が自分で始めたターン」からなる。
 * 次の指示では古いセッションを閉じて新しく起動するので、履歴を持たない前提は保たれる。
 *
 * CLI が自分で始めたターンの見分け方（reports/mod-surface-protocol.md の段階 B で実測）:
 * - --replay-user-messages を付けると、mod が積んだプロンプトが origin 付きの user メッセージで届く
 *   （origin: { kind: "plugin", name: "push-gate" }、isReplay: true）。本文の stream_event より先に届く
 * - それがなくても、ターンの外で本文（stream_event・assistant）が届いたら、続きのターンとして読む
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import {
  buildSdkOptions,
  importSdk,
  preparePrompt,
  toRunResult,
  TurnReader,
  type OutputBudget,
  type RunOptions,
  type RunResult,
  type TurnHandlers,
} from "./agent.js";
import type { ContextBudget } from "./contextbudget.js";
import { unwrapPluginPrompt } from "./modui.js";
import type { AgentState } from "./state.js";

/** CLI が自分で始めたターンの始まり。 */
export interface FollowUpStart {
  /** ターンを始めた相手。mod ならその名前、それ以外は origin の種類。分からなければ null。 */
  from: string | null;
  /** 相手が積んだプロンプトの本文。分からなければ null。 */
  prompt: string | null;
}

/** 続きのターンの受け口。ターンごとに作り直す。 */
export interface TurnScope {
  handlers: TurnHandlers;
  /** このターンの context 予算。出力を削るフックはこれを見る。 */
  budget?: ContextBudget;
}

/** ターンの終わり。followUp は CLI が自分で始めたターンか。 */
export type TurnEnd = { followUp: boolean } & ({ ok: true; result: RunResult } | { ok: false; error: unknown });

/** SDK の query のうち、ここで使う形。テストで差し替える。 */
export type QueryImpl = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Record<string, unknown>;
}) => AsyncIterable<unknown> & { close(): void };

export interface SessionOptions extends RunOptions {
  /** CLI が自分でターンを始めた。このターンの受け口を返す。 */
  onFollowUpStart: (start: FollowUpStart) => TurnScope;
  /**
   * ターンが終わった（人の指示のターンも、続きのターンも）。
   * ここから戻るまで次のメッセージは読まないので、後処理はここで済ませてよい。
   */
  onTurnEnd: (end: TurnEnd) => void;
  /** 続きのターンのパッチを当てる state。ターンが終わった時点で読む。 */
  currentState: () => AgentState;
  /** CLI が止まった。 */
  onClosed?: () => void;
  /** 閉じると決めたあとで CLI がターンを始めたので、受け口を作らずに打ち切った。 */
  onFollowUpDropped?: (start: FollowUpStart) => void;
  /** テスト用。省略すると SDK の query を使う。 */
  queryImpl?: QueryImpl;
}

export interface AgentSession {
  /** 人の指示のターンが終わり、onTurnEnd から戻ったら解決する。失敗しても reject しない。 */
  readonly firstTurn: Promise<void>;
  /** ターンが走っているか。 */
  readonly busy: boolean;
  /**
   * CLI を止める。ターンが走っていなければ stdin を閉じて静かに止め、走っていれば打ち切る。
   * 閉じると決めたあとで CLI が始めたターンも打ち切る（次の指示と混ざらないように）。
   */
  close(): void;
}

/**
 * ターンの外で届いたメッセージが、CLI が自分で始めたターンの始まりかを見る。
 * 始まりなら、相手と本文を返す。consumed は、そのメッセージ自体はターンの中身でないこと。
 */
export function followUpStartOf(m: Record<string, unknown>): { start: FollowUpStart; consumed: boolean } | null {
  if (m.type === "user" && m.isReplay === true && typeof m.origin === "object" && m.origin !== null) {
    const origin = m.origin as { kind?: unknown; name?: unknown };
    const plugin = origin.kind === "plugin" && typeof origin.name === "string" ? origin.name : null;
    const text = promptText(m.message);
    return {
      start: {
        from: plugin ?? (typeof origin.kind === "string" ? origin.kind : null),
        prompt: text !== null && plugin !== null ? unwrapPluginPrompt(text) : text,
      },
      consumed: true,
    };
  }
  if (m.type === "stream_event" || m.type === "assistant") {
    return { start: { from: null, prompt: null }, consumed: false };
  }
  return null;
}

/** user メッセージの本文。content は文字列のことも、text ブロックの配列のこともある。 */
function promptText(message: unknown): string | null {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((block) => {
      const b = block as { type?: string; text?: unknown };
      return b.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .join("");
  return text === "" ? null : text;
}

/** CLI を起動し、人の指示のターンを始める。CLI はターンのあとも残り、close() で止まる。 */
export function startSession(opts: SessionOptions): AgentSession {
  const { prompt, isolating } = preparePrompt(opts);

  let scope: TurnScope = { handlers: opts, budget: opts.budget };
  // フックは CLI を起動するときに 1 度だけ渡す。続きのターンでは予算を作り直すので、いまのターンの予算を見る口を渡す
  const outputBudget: OutputBudget = {
    applyOutput: (tool, response) => scope.budget?.applyOutput(tool, response) ?? null,
  };

  const sdkOptions = buildSdkOptions({
    cwd: opts.cwd,
    mode: opts.mode,
    sessionId: opts.sessionId,
    canUseTool: opts.canUseTool,
    abortController: opts.abortController,
    budget: outputBudget,
    isolating,
    spawnClaudeCodeProcess: opts.spawnClaudeCodeProcess,
    pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable,
    replayUserMessages: true,
  });

  // 閉じるまで終わらない入力。入力が終わると SDK が stdin を閉じ、CLI は自分で止まる
  let endInput!: () => void;
  const inputEnded = new Promise<void>((resolve) => (endInput = resolve));
  const first: SDKUserMessage = {
    type: "user",
    session_id: "",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    parent_tool_use_id: null,
  };
  const input = (async function* () {
    yield first;
    await inputEnded;
  })();

  // as で書く: 初期値で "first" に絞り込まれると、finishTurn() の中での代入がループから見えない
  let phase = "first" as "first" | "idle" | "followUp" | "closed";
  let closing = false;
  /** 閉じると決めたあとで始まったターンを打ち切ったか。 */
  let dropped = false;
  let reader = new TurnReader(opts);
  let sessionId: string | undefined;
  let rateLimit: unknown;
  /** 起動した CLI（SDK の query）。打ち切るときに close() を呼ぶ。 */
  let cli: { close(): void } | undefined;
  let settleFirst!: () => void;
  const firstTurn = new Promise<void>((resolve) => (settleFirst = resolve));

  const report = (end: TurnEnd): void => {
    try {
      opts.onTurnEnd(end);
    } finally {
      if (!end.followUp) {
        settleFirst();
      }
    }
  };

  const finishTurn = (): void => {
    const followUp = phase === "followUp";
    // 人の指示のターンは、プロンプトに載せた state にパッチを当てる。続きのターンは、その時点の state に当てる
    const state = followUp ? opts.currentState() : opts.state;
    const result = toRunResult(state, reader, { sessionId, rateLimit, budget: scope.budget });
    phase = "idle";
    report({ followUp, ok: true, result });
  };

  const onEnded = (error: unknown): void => {
    const was = phase;
    phase = "closed";
    if (was === "first" || was === "followUp") {
      const reason = error ?? new Error(closing ? "CLI を止めた" : "CLI がターンの途中で止まった");
      report({ followUp: was === "followUp", ok: false, error: reason });
    }
    opts.onClosed?.();
  };

  void (async () => {
    try {
      const query: QueryImpl =
        opts.queryImpl ?? (await importSdk().then((sdk) => (p) => sdk.query({ prompt: p.prompt, options: p.options as never })));
      const q = query({ prompt: input, options: sdkOptions });
      cli = q;
      if (closing) {
        q.close(); // 起動を待つ間に閉じると決まった
      }

      for await (const message of q) {
        const m = message as Record<string, unknown>;

        if (m.type === "system" && m.subtype === "init") {
          sessionId = (m.session_id as string | undefined) ?? sessionId;
          continue;
        }
        if (m.type === "rate_limit_event") {
          rateLimit = m.rate_limit_info;
          continue;
        }

        if (phase === "idle") {
          const found = followUpStartOf(m);
          if (found === null) {
            continue; // ターンの外の通知（ui_* や command_lifecycle など）
          }
          if (closing) {
            // 打ち切ったあとも、止まるまでは同じターンの本文が届く。知らせるのは 1 度だけ
            if (!dropped) {
              dropped = true;
              q.close();
              opts.onFollowUpDropped?.(found.start);
            }
            continue;
          }
          scope = opts.onFollowUpStart(found.start);
          reader = new TurnReader(scope.handlers);
          phase = "followUp";
          if (found.consumed) {
            continue;
          }
        }

        if (reader.read(m)) {
          finishTurn();
        }
      }
      onEnded(undefined);
    } catch (e) {
      onEnded(e);
    }
  })();

  return {
    firstTurn,
    get busy() {
      return phase === "first" || phase === "followUp";
    },
    close() {
      if (closing || phase === "closed") {
        return;
      }
      closing = true;
      endInput();
      if (phase !== "idle") {
        cli?.close();
      }
    },
  };
}
