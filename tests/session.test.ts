/**
 * ターンのあとも CLI を残すセッション（startSession）のテスト。
 *
 * SDK の query の代わりに、台本どおりメッセージを流す偽物を差し込む。
 * メッセージの並びは reports/mod-surface-protocol.md の段階 B で CLI 2.1.295 から記録したもの
 * （承認ボタンを押す → command_lifecycle → init → 再生されたプロンプト → 本文 → result）。
 */

import { describe, expect, it, vi } from "vitest";
import { buildPostToolUseHook } from "../src/core/agent.js";
import { startSession, type FollowUpStart, type QueryImpl, type SessionOptions, type TurnEnd } from "../src/core/session.js";
import { INITIAL_STATE } from "../src/core/state.js";

/** 偽の CLI。push した行を順に流し、入力（stdin）が終わったら止まる。 */
class FakeQuery {
  /** CLI が受け取ったプロンプト。 */
  readonly prompts: unknown[] = [];
  options: Record<string, unknown> = {};
  inputEnded = false;
  closed = false;
  private readonly queue: unknown[] = [];
  private finished = false;
  private failure: unknown;
  private wake: (() => void) | undefined;

  readonly impl: QueryImpl = ({ prompt, options }) => {
    this.options = options;
    void (async () => {
      for await (const m of prompt) {
        this.prompts.push(m);
      }
      this.inputEnded = true;
      this.end(); // stdin が閉じたら、CLI は残りを流して止まる
    })();
    const self = this;
    const lines = (async function* () {
      for (;;) {
        if (self.queue.length > 0) {
          yield self.queue.shift();
          continue;
        }
        if (self.failure !== undefined) throw self.failure;
        if (self.finished) return;
        await new Promise<void>((resolve) => (self.wake = resolve));
      }
    })();
    return Object.assign(lines, {
      close: () => {
        this.closed = true;
        this.end();
      },
    });
  };

  push(...lines: unknown[]): void {
    this.queue.push(...lines);
    this.wake?.();
  }

  end(): void {
    this.finished = true;
    this.wake?.();
  }

  fail(error: unknown): void {
    this.failure = error;
    this.wake?.();
  }
}

// ---------- CLI が流す行 ----------

const init = { type: "system", subtype: "init", session_id: "s1" };
const text = (t: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: t } },
});
const assistant = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const result = { type: "result", subtype: "success", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 };
/** mod が $.prompt.submit() で積んだプロンプトの再生（--replay-user-messages）。 */
const pluginPrompt = (name: string, body: string) => ({
  type: "user",
  isReplay: true,
  origin: { kind: "plugin", name },
  message: {
    role: "user",
    content: `The ${name} plugin sent a message:\n${body}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`,
  },
});
/** 承認ボタンを押してから、続きのターンの本文までに届く行。 */
const followUpPreamble = [
  { type: "system", subtype: "ui_invalidate", event: "ui.render" },
  { type: "command_lifecycle", command_uuid: "c1", state: "started" },
  init,
];
const stateFence = (patch: Record<string, unknown>) => "\n```state\n" + JSON.stringify(patch) + "\n```\n";

function setup(over: Partial<SessionOptions> = {}) {
  const fake = new FakeQuery();
  const ends: TurnEnd[] = [];
  const starts: FollowUpStart[] = [];
  const texts: string[] = [];
  const followTexts: string[] = [];
  let closedCount = 0;
  const session = startSession({
    state: INITIAL_STATE,
    instruction: "push して",
    mode: "stateless",
    recentTurns: 0,
    history: [],
    cwd: "/w",
    onText: (t) => texts.push(t),
    currentState: () => ({ ...INITIAL_STATE, 目的: "いまの目的" }),
    onFollowUpStart: (start) => {
      starts.push(start);
      return { handlers: { onText: (t) => followTexts.push(t) } };
    },
    onTurnEnd: (e) => ends.push(e),
    onClosed: () => closedCount++,
    queryImpl: fake.impl,
    ...over,
  });
  return { fake, session, ends, starts, texts, followTexts, closed: () => closedCount };
}

/** 人の指示のターンを終えたところまで進める。 */
async function firstTurnDone(fake: FakeQuery, session: { firstTurn: Promise<void> }) {
  fake.push(init, text("拒否された"), assistant("拒否された"), result);
  await session.firstTurn;
}

const okResult = (e: TurnEnd | undefined) => {
  if (!e?.ok) throw new Error(`ok でない: ${JSON.stringify(e)}`);
  return e.result;
};

describe("startSession: 人の指示のターン", () => {
  it("プロンプトを 1 通送り、result のあとも入力を閉じない（CLI が残る）", async () => {
    const { fake, session, ends, texts } = setup();
    expect(session.busy).toBe(true);
    await firstTurnDone(fake, session);

    expect(ends).toHaveLength(1);
    expect(ends[0]?.followUp).toBe(false);
    expect(okResult(ends[0])).toMatchObject({ response: "拒否された", sessionId: "s1", usage: { inputTokens: 10 } });
    expect(texts).toEqual(["拒否された"]);
    expect(fake.prompts).toHaveLength(1);
    expect(JSON.stringify(fake.prompts[0])).toContain("push して");
    expect(fake.inputEnded).toBe(false);
    expect(session.busy).toBe(false);
  });

  it("--replay-user-messages を付けて起動する（mod が積んだプロンプトを見るため）", () => {
    const { fake } = setup();
    return vi.waitFor(() => expect(fake.options.extraArgs).toEqual({ "replay-user-messages": null }));
  });

  it("state パッチは、プロンプトに載せた state に当てる", async () => {
    const { fake, session, ends } = setup({ state: { ...INITIAL_STATE, 目的: "最初" } });
    fake.push(init, assistant("やった" + stateFence({ 次の一手: "確認" })), result);
    await session.firstTurn;
    expect(okResult(ends[0])).toMatchObject({ statePatched: true, state: { 目的: "最初", 次の一手: "確認" } });
  });

  it("自分のプロンプトの再生（origin なし）は、続きのターンにしない", async () => {
    const { fake, session, ends, starts } = setup();
    const ownReplay = { type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: "push して" }] } };
    fake.push(init, ownReplay, assistant("はい"), result);
    await session.firstTurn;
    expect(starts).toHaveLength(0);
    expect(ends).toHaveLength(1);
  });

  it("CLI がターンの途中で落ちたら ok:false を返し、firstTurn は解決する", async () => {
    const { fake, session, ends, closed } = setup();
    fake.push(init, text("途中"));
    fake.fail(new Error("CLI が落ちた"));
    await session.firstTurn;
    expect(ends).toEqual([{ followUp: false, ok: false, error: new Error("CLI が落ちた") }]);
    expect(closed()).toBe(1);
  });
});

describe("startSession: CLI が自分で始めたターン", () => {
  it("mod が積んだプロンプトで続きのターンを始め、送り主と本文を渡す", async () => {
    const { fake, session, ends, starts, texts, followTexts } = setup();
    await firstTurnDone(fake, session);

    const body = "push-gate: 承認しました。\n\n```sh\ngit push origin main\n```";
    fake.push(...followUpPreamble, pluginPrompt("push-gate", body), text("push した"), assistant("push した"), result);
    await vi.waitFor(() => expect(ends).toHaveLength(2));

    expect(starts).toEqual([{ from: "push-gate", prompt: body }]);
    expect(ends[1]?.followUp).toBe(true);
    expect(okResult(ends[1]).response).toBe("push した");
    // 続きのターンの本文は、そのターンの受け口に流す
    expect(followTexts).toEqual(["push した"]);
    expect(texts).toEqual(["拒否された"]);
  });

  it("続きのターンの state パッチは、その時点の state に当てる", async () => {
    const { fake, session, ends } = setup();
    await firstTurnDone(fake, session);
    fake.push(pluginPrompt("push-gate", "承認"), assistant("済んだ" + stateFence({ 次の一手: "PR を作る" })), result);
    await vi.waitFor(() => expect(ends).toHaveLength(2));
    expect(okResult(ends[1]).state).toMatchObject({ 目的: "いまの目的", 次の一手: "PR を作る" });
  });

  it("再生がなくても、ターンの外で本文が届いたら続きのターンとして読む", async () => {
    const { fake, session, ends, starts, followTexts } = setup();
    await firstTurnDone(fake, session);
    fake.push(text("続き"), assistant("続き"), result);
    await vi.waitFor(() => expect(ends).toHaveLength(2));
    expect(starts).toEqual([{ from: null, prompt: null }]);
    expect(followTexts).toEqual(["続き"]);
  });

  it("ターンの外の通知（ui_*・command_lifecycle・本文のない result）は読み流す", async () => {
    const { fake, session, ends, starts } = setup();
    await firstTurnDone(fake, session);
    fake.push(
      { type: "system", subtype: "ui_toast", plugin: "push-gate", text: "待っています", timeout_ms: 4000 },
      { type: "command_lifecycle", command_uuid: "c1", state: "completed" },
      result,
    );
    fake.end();
    await vi.waitFor(() => expect(session.busy).toBe(false));
    await new Promise((r) => setImmediate(r));
    expect(starts).toHaveLength(0);
    expect(ends).toHaveLength(1);
  });

  it("busy は続きのターンの間も true", async () => {
    const { fake, session, ends } = setup();
    await firstTurnDone(fake, session);
    fake.push(pluginPrompt("push-gate", "承認"));
    await vi.waitFor(() => expect(session.busy).toBe(true));
    fake.push(assistant("済んだ"), result);
    await vi.waitFor(() => expect(ends).toHaveLength(2));
    expect(session.busy).toBe(false);
  });

  it("出力を削るフックは、いま走っているターンの予算を見る", async () => {
    const budget = (tag: string) => ({ applyOutput: () => tag, planIsolation: () => false, summary: () => null }) as never;
    const { fake, session, ends } = setup({
      budget: budget("最初のターン"),
      onFollowUpStart: () => ({ handlers: {}, budget: budget("続きのターン") }),
    });
    await vi.waitFor(() => expect(fake.options.hooks).toBeDefined());
    const hooks = fake.options.hooks as { PostToolUse: Array<{ hooks: Array<ReturnType<typeof buildPostToolUseHook>> }> };
    const hook = hooks.PostToolUse[0]!.hooks[0]!;
    const call = { tool_name: "Bash", tool_response: "長い出力" };

    expect(await hook(call)).toMatchObject({ hookSpecificOutput: { updatedToolOutput: "最初のターン" } });
    await firstTurnDone(fake, session);
    fake.push(pluginPrompt("push-gate", "承認"));
    await vi.waitFor(() => expect(session.busy).toBe(true));
    expect(await hook(call)).toMatchObject({ hookSpecificOutput: { updatedToolOutput: "続きのターン" } });
    fake.push(result);
    await vi.waitFor(() => expect(ends).toHaveLength(2));
  });
});

describe("startSession: 閉じる", () => {
  it("ターンのあとで閉じると、入力を終えて CLI を静かに止める（打ち切らない）", async () => {
    const { fake, session, closed } = setup();
    await firstTurnDone(fake, session);
    session.close();
    await vi.waitFor(() => expect(closed()).toBe(1));
    expect(fake.inputEnded).toBe(true);
    expect(fake.closed).toBe(false);
  });

  it("ターンの途中で閉じると打ち切り、ok:false を返す", async () => {
    const { fake, session, ends, texts } = setup();
    fake.push(init, text("途中"));
    await vi.waitFor(() => expect(texts).toEqual(["途中"]));
    session.close();
    await session.firstTurn;
    expect(fake.closed).toBe(true);
    expect(ends).toEqual([{ followUp: false, ok: false, error: new Error("CLI を止めた") }]);
  });

  it("閉じると決めたあとで CLI が始めたターンは、受け口を作らずに打ち切り、そのことを知らせる", async () => {
    const dropped: FollowUpStart[] = [];
    const { fake, session, ends, starts } = setup({ onFollowUpDropped: (start) => dropped.push(start) });
    await firstTurnDone(fake, session);
    // 承認ボタンを押した直後に次の指示が来た（CLI はもうターンを始めている）
    session.close();
    fake.push(pluginPrompt("push-gate", "承認"), text("push する"));
    await vi.waitFor(() => expect(fake.closed).toBe(true));
    expect(starts).toHaveLength(0);
    expect(ends).toHaveLength(1);
    expect(dropped).toEqual([{ from: "push-gate", prompt: "承認" }]);
  });
});
