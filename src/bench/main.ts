/**
 * 対照実験ベンチ。
 *
 * stateless / recent / full を**同じプロンプト列・同じ順序**で回し、
 * ターンを重ねたときのコストと時間の伸び方を比べる。
 *
 * 各モードは独立した作業ディレクトリを持つ（state も履歴も混ざらない）。
 * Docker は使わない — 必要なのはプロセス分離ではなく、
 * state と会話履歴が互いに漏れないことだけ。
 *
 * 使い方:
 *   node dist/bench.js --repo <対象リポジトリ> --turns 12
 *   node dist/bench.js --repo ~/Develop/devtch --turns 30 --modes recent,stateless
 *
 * context 予算の効き幅を分離して測る（1層ずつ足す）:
 *   node dist/bench.mjs --repo <対象> --turns 12 --modes recent
 *   node dist/bench.mjs --repo <対象> --turns 12 --modes recent --layers narrow
 *   node dist/bench.mjs --repo <対象> --turns 12 --modes recent --layers narrow,trim
 *   node dist/bench.mjs --repo <対象> --turns 12 --modes recent --layers all
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { run, type Turn } from "../core/agent.js";
import { ContextBudget, DEFAULT_CONFIG } from "../core/contextbudget.js";
import { INITIAL_STATE, parseState, serializeState, type AgentState, type HistoryMode } from "../core/state.js";
import {
  buildComparison,
  nextPrompt,
  parseScenario,
  summarizeTools,
  type BenchTurn,
  type ToolCall,
} from "./scenario.js";

interface Options {
  repo: string;
  turns: number;
  modes: HistoryMode[];
  scenario: string;
  outDir: string;
  recentTurns: number;
  /**
   * 有効にする context 予算の層。`--layers isolate,narrow,trim`。
   * 既定は無し（従来どおり）。層を足しながら回して効き幅を分離して測る。
   */
  layers: { isolate: boolean; narrowInput: boolean; trimOutput: boolean } | null;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, fallback?: string): string => {
    const at = argv.indexOf(`--${name}`);
    if (at >= 0 && argv[at + 1] !== undefined) {
      return argv[at + 1];
    }
    if (fallback === undefined) {
      throw new Error(`--${name} を指定してください`);
    }
    return fallback;
  };

  return {
    repo: resolve(get("repo").replace(/^~/, process.env.HOME ?? "~")),
    turns: Number(get("turns", "12")),
    modes: get("modes", "stateless,recent,full").split(",") as HistoryMode[],
    // import.meta は tsconfig が CommonJS 向けなので使えない。
    // 実行中のスクリプト（dist/bench.mjs）の隣を見る。
    scenario: get("scenario", join(dirname(process.argv[1] ?? "."), "default.txt")),
    outDir: get("out", ".bench"),
    recentTurns: Number(get("recent-turns", "3")),
    layers: parseLayers(get("layers", "")),
  };
}

/**
 * `--layers` を解釈する。空なら null（層なし）。
 *
 * 層を個別に指定できるようにするのは、3層を一度に入れると
 * どれが効いたのか分離できないため。1層ずつ足して測る。
 */
function parseLayers(
  raw: string,
): { isolate: boolean; narrowInput: boolean; trimOutput: boolean } | null {
  if (raw.trim() === "") {
    return null;
  }
  const names = raw.split(",").map((x) => x.trim());
  const all = names.includes("all");
  return {
    isolate: all || names.includes("isolate"),
    narrowInput: all || names.includes("narrow"),
    trimOutput: all || names.includes("trim"),
  };
}

/** モードごとの作業場所。state と履歴をここに閉じ込める。 */
function workspaceFor(outDir: string, mode: string): string {
  return join(outDir, mode);
}

function loadState(dir: string): AgentState {
  const p = join(dir, "state.json");
  return existsSync(p) ? parseState(readFileSync(p, "utf8")) : { ...INITIAL_STATE };
}

function saveState(dir: string, state: AgentState): number {
  const p = join(dir, "state.json");
  const body = serializeState(state);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf8");
  return Buffer.byteLength(body, "utf8");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (!existsSync(opts.repo)) {
    console.error(`対象リポジトリが見つからない: ${opts.repo}`);
    process.exit(1);
  }
  if (!existsSync(opts.scenario)) {
    console.error(`シナリオが見つからない: ${opts.scenario}`);
    process.exit(1);
  }

  const scenario = parseScenario(readFileSync(opts.scenario, "utf8"));
  if (scenario.prompts.length === 0) {
    console.error("シナリオが空");
    process.exit(1);
  }

  console.log(`対象: ${opts.repo}`);
  console.log(`シナリオ: ${scenario.prompts.length} 問を巡回`);
  console.log(`モード: ${opts.modes.join(" / ")} × ${opts.turns} ターン`);
  console.log(
    `context 予算: ${
      opts.layers === null
        ? "なし"
        : [
            opts.layers.isolate ? "隔離" : null,
            opts.layers.narrowInput ? "入力を絞る" : null,
            opts.layers.trimOutput ? "出力を削る" : null,
          ]
            .filter((x) => x !== null)
            .join(" + ") || "なし"
    }\n`,
  );

  const results: BenchTurn[] = [];
  const logPath = join(opts.outDir, "turns.jsonl");
  mkdirSync(opts.outDir, { recursive: true });

  for (const mode of opts.modes) {
    // モードごとに状態を作り直す。前の実験の state を引き継ぐと比較にならない。
    const dir = workspaceFor(opts.outDir, mode);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const history: Turn[] = [];
    let sessionId: string | undefined;
    let state = { ...INITIAL_STATE };

    for (let i = 0; i < opts.turns; i++) {
      const prompt = nextPrompt(scenario, i);
      if (prompt === null) {
        break;
      }

      const startedAt = Date.now();
      // 応答待ちが長いので、投げた時点で見えるようにする。
      // これが無いと「止まっているのか待っているのか」が分からない。
      process.stdout.write(
        `  [${mode}] ${String(i + 1).padStart(3)}/${opts.turns} 実行中… `,
      );
      // そのターンで何をしたかを残す。トークン数だけでは
      // 「なぜ重かったか」を説明できない。
      const calls: ToolCall[] = [];
      // ターンごとに作り直す。持ち回すと予算が枯れたまま次ターンに入る。
      const budget =
        opts.layers === null
          ? undefined
          : new ContextBudget({ ...DEFAULT_CONFIG, layers: opts.layers });

      let result;
      try {
        result = await run({
          state,
          instruction: prompt,
          mode,
          recentTurns: opts.recentTurns,
          history,
          // 対象リポジトリで動かす。読むファイルを揃えないと比較にならない。
          cwd: opts.repo,
          sessionId,
          budget,
          onToolUse: (_id, name, input) => {
            calls.push({ name, input });
          },
        });
      } catch (e) {
        console.error(`失敗 — ${e instanceof Error ? e.message : e}`);
        break;
      }
      const ms = Date.now() - startedAt;

      sessionId = result.sessionId ?? sessionId;
      history.push({ instruction: prompt, response: result.response });
      state = result.state;
      const stateBytes = saveState(dir, state);

      const turn: BenchTurn = {
        mode,
        index: i,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        cacheReadTokens: result.usage?.cacheReadTokens ?? 0,
        cacheCreationTokens: result.usage?.cacheCreationTokens ?? 0,
        costUSD: result.usage?.costUSD ?? 0,
        ms,
        statePatched: result.stateWarnings !== undefined && state !== undefined,
        stateBytes,
        tools: summarizeTools(calls),
      };
      results.push(turn);
      // 途中で落ちても失われないよう1ターンごとに書く。
      writeFileSync(logPath, results.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

      console.log(
        `in=${turn.inputTokens}` +
          ` out=${turn.outputTokens}` +
          ` cache=${turn.cacheReadTokens.toLocaleString()}` +
          ` $${turn.costUSD.toFixed(2)}` +
          ` ${(ms / 1000).toFixed(1)}s` +
          ` state=${turn.stateBytes}B` +
          ` tools=${turn.tools?.total ?? 0}(${turn.tools?.filesRead.length ?? 0}files)`,
      );
    }
    console.log("");
  }

  report(results);
}

function report(turns: BenchTurn[]): void {
  const comparison = buildComparison(turns);
  console.log("=".repeat(72));
  for (const [mode, c] of Object.entries(comparison)) {
    console.log(
      `${mode.padEnd(10)} ${c.turns}ターン  $${c.totalCostUSD.toFixed(2)}` +
        `  平均 out ${c.avgOut.toLocaleString()}` +
        `  ${(c.avgMs / 1000).toFixed(1)}s/ターン`,
    );
    console.log(
      `${" ".repeat(10)} cache ${c.firstCacheRead.toLocaleString()}→${c.lastCacheRead.toLocaleString()}` +
        ` (+${c.cacheGrowthPerTurn.toLocaleString()}/ターン)` +
        `  state ${c.lastStateBytes}B`,
    );
  }
  console.log("=".repeat(72));

  reportTools(turns);
}

/**
 * どのファイルが繰り返し読まれたかを出す。
 *
 * cache_read が数十万に達する理由はここにある。
 * 毎ターン同じファイルを読み直しているなら、そこが削減の当てになる。
 */
function reportTools(turns: BenchTurn[]): void {
  const readCount = new Map<string, number>();
  let totalCalls = 0;

  for (const t of turns) {
    totalCalls += t.tools?.total ?? 0;
    for (const file of t.tools?.filesRead ?? []) {
      readCount.set(file, (readCount.get(file) ?? 0) + 1);
    }
  }

  if (totalCalls === 0) {
    return;
  }

  const top = [...readCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`\nツール呼び出し ${totalCalls} 回 / 読んだファイル ${readCount.size} 種`);
  console.log("繰り返し読まれたファイル:");
  for (const [file, count] of top) {
    console.log(`  ${String(count).padStart(3)}回  ${file}`);
  }
}

void main();
