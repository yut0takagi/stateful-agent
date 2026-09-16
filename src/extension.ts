/**
 * VSCode 拡張のエントリ。各層を配線する。
 *
 *   Webview(UI) ── extension.ts ── agent.ts ── Agent SDK ── claude.ai OAuth
 *                        │
 *                        ├── state.ts    (.ctx/state/current.json)
 *                        └── engine.ts   (.agent/rules/*.yaml → canUseTool)
 *
 * 公式拡張は同梱バイナリを子プロセスで起動するが、こちらは SDK を直接呼ぶ。
 * だから履歴の持ち方を自分で決められる。
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import * as vscode from "vscode";
import { run, type Turn } from "./core/agent.js";
import {
  applyEdit,
  INITIAL_STATE,
  parseState,
  serializeState,
  dedupeIds,
  StreamFilter,
  stripStateFence,
  toEditable,
  type AgentState,
  type HistoryMode,
} from "./core/state.js";
import { buildRunRecord, formatRunLine, parseRunLog, summarize } from "./core/metrics.js";
import { buildGraph, layoutGraph, toRenderModel } from "./core/graph.js";
import { SendQueue } from "./core/queue.js";
import { renderBashResult, summarizeToolUse } from "./core/toolview.js";
import { ContextBudget, DEFAULT_CONFIG, type ContextBudgetConfig } from "./core/contextbudget.js";
import { evaluate, type EngineDeps } from "./rules/engine.js";
import {
  loadRules,
  loadTypeMap,
  resolveManifestPath,
  resolveTypeFrom,
  EMPTY_RULESET,
} from "./rules/loader.js";
import type { RuleSet } from "./rules/types.js";

let extensionUri: vscode.Uri | undefined;
/** センターに開いたときの Webview パネル。サイドバーと同じ HTML を使う。 */
let centerPanel: vscode.WebviewPanel | undefined;
let graphPanel: vscode.WebviewView | undefined;
/** 実行中のターンを止めるための controller。走っていなければ undefined。 */
let running: AbortController | undefined;

/**
 * 実行中に投げられた指示を溜める。
 *
 * 走っている間も入力を受け付けたい。捨てるのではなく積んで、
 * 終わり次第つなげて実行する。Webview 側に持つと再読み込みで消えるので拡張側に置く。
 */
const queue = new SendQueue();
const history: Turn[] = [];
let sessionId: string | undefined;

/** ツール呼び出し id → 表示用の情報。結果が返ったときに紐づける。 */
const toolCards = new Map<string, { name: string }>();

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("statefulAgent").get<T>(key) ?? fallback;
}

// ---------- state ----------

function statePath(root: string): string {
  return join(root, config("statePath", ".ctx/state/current.json"));
}

function loadState(root: string): AgentState {
  const p = statePath(root);
  if (!existsSync(p)) {
    return { ...INITIAL_STATE };
  }
  // 読むたびに id の重複を直す。applyPatch は受信時に防ぐが、
  // それ以前に書かれた重複は残るため（実測: D6 / D7 が別内容で2件ずつ）。
  return dedupeIds(parseState(readFileSync(p, "utf8")));
}

function saveState(root: string, state: AgentState): void {
  const p = statePath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, serializeState(state), "utf8");
}

/** グラフビューに現在の state を送る。開いていなければ何もしない。 */
function postGraph(state: AgentState): void {
  if (!graphPanel) {
    return;
  }
  // postMessage は構造化クローンなので Class のメソッドは渡らない。
  // ドメインは拡張側に留め、訳し終えた描画指示だけを送る。
  const model = toRenderModel(layoutGraph(buildGraph(state)));
  void graphPanel.webview.postMessage({ type: "graph", ...model });
}

// ---------- 実測ログ ----------

function runLogPath(root: string): string {
  return join(dirname(statePath(root)), "runs.jsonl");
}

/** 1ターン分を runs.jsonl に追記する。失敗しても本処理は止めない。 */
function appendRunLog(root: string, line: string): void {
  try {
    const p = runLogPath(root);
    mkdirSync(dirname(p), { recursive: true });
    // 直前の行が改行で終わっていなければ足す。
    // 実測で2レコードが1行に連結し、1ターンぶんの計測が集計から消えた。
    appendFileSync(p, needsNewline(p) ? "\n" + line : line, "utf8");
  } catch {
    // 計測が落ちても作業は続ける
  }
}

/** 既存ファイルが改行で終わっていないか。空・不在なら不要。 */
function needsNewline(path: string): boolean {
  try {
    if (!existsSync(path)) {
      return false;
    }
    const size = statSync(path).size;
    if (size === 0) {
      return false;
    }
    // 末尾1バイトだけ読む。ログ全体を読むと行数に比例して重くなる。
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(1);
      readSync(fd, buf, 0, 1, size - 1);
      return buf.toString("utf8") !== "\n";
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

// ---------- 規律 ----------

function buildEngineDeps(root: string): EngineDeps {
  // 対応表の在処はリポジトリによって違う。vault は vault設計/manifest.yaml、
  // それ以外は .agent/manifest.yaml。設定 manifestPath で明示指定もできる。
  const configured = config("manifestPath", "");
  const manifestPath = resolveManifestPath(root, configured || undefined, existsSync);
  const typeMap = manifestPath !== null ? loadTypeMap(readFileSync(manifestPath, "utf8")) : [];

  return {
    readFile: (p) => {
      const abs = p.startsWith("/") ? p : join(root, p);
      try {
        return readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    },
    runCommand: (command) => {
      try {
        const output = execFileSync("bash", ["-c", command], {
          cwd: root,
          encoding: "utf8",
          timeout: 60_000,
        });
        return { ok: true, output };
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return { ok: false, output: err.stdout ?? err.stderr ?? err.message ?? "" };
      }
    },
    resolveType: (p) => resolveTypeFrom(typeMap, p),
  };
}

function loadRuleSet(root: string): RuleSet {
  const dir = join(root, config("rulesDir", ".agent/rules"));
  if (!existsSync(dir)) {
    return EMPTY_RULESET;
  }
  return loadRules(dir, {
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    listFiles: (d) => {
      try {
        return readdirSync(d).map((f) => join(d, f));
      } catch {
        return [];
      }
    },
  });
}

/**
 * ファイルの行数とバイト数を数える。
 *
 * 読めなければ null を返し、呼び出し側は「触らない」を選ぶ。
 * 推測で範囲を付けると短いファイルの後半を理由なく隠すことになる。
 */
function fileFacts(root: string, path: string): { lines: number | null; bytes: number | null } {
  const abs = path.startsWith("/") ? path : join(root, path);
  try {
    const bytes = statSync(abs).size;
    // 巨大ファイルを行数のために全読みしたら本末転倒。
    if (bytes > 2_000_000) {
      return { lines: null, bytes };
    }
    return { lines: readFileSync(abs, "utf8").split("\n").length, bytes };
  } catch {
    return { lines: null, bytes: null };
  }
}

/** 設定から context 予算の構成を読む。 */
function budgetConfig(): ContextBudgetConfig {
  return {
    layers: {
      isolate: config("contextBudget.isolateExploration", true),
      narrowInput: config("contextBudget.narrowInput", true),
      trimOutput: config("contextBudget.trimOutput", true),
    },
    read: {
      maxLines: config("contextBudget.read.maxLines", DEFAULT_CONFIG.read.maxLines),
      windowLines: config("contextBudget.read.windowLines", DEFAULT_CONFIG.read.windowLines),
      maxBytes: config("contextBudget.read.maxBytes", DEFAULT_CONFIG.read.maxBytes),
    },
    output: {
      read: config("contextBudget.output.read", DEFAULT_CONFIG.output.read),
      bash: config("contextBudget.output.bash", DEFAULT_CONFIG.output.bash),
      search: config("contextBudget.output.search", DEFAULT_CONFIG.output.search),
      other: config("contextBudget.output.other", DEFAULT_CONFIG.output.other),
      turnTotal: config("contextBudget.output.turnTotal", DEFAULT_CONFIG.output.turnTotal),
    },
    bashOutputLines: config("contextBudget.bashOutputLines", DEFAULT_CONFIG.bashOutputLines),
  };
}

/** 規律エンジンを SDK の canUseTool に橋渡しする。 */
function makeCanUseTool(root: string, budget: ContextBudget) {
  const ruleSet = loadRuleSet(root);
  const deps = buildEngineDeps(root);

  return async (toolName: string, input: Record<string, unknown>) => {
    // 相対パスに正規化してから規律にかける（glob は相対で書かれている）
    const normalized = { ...input };
    for (const key of ["file_path", "notebook_path", "path"]) {
      const v = normalized[key];
      if (typeof v === "string" && v.startsWith(root)) {
        normalized[key] = relative(root, v);
      }
    }

    const decision = evaluate(ruleSet, toolName, normalized, deps);

    if (decision.behavior === "deny") {
      post({ type: "rule", mark: "⛔", level: "warn", text: `${decision.ruleId}: ${decision.message}` });
      return { behavior: "deny" as const, message: decision.message };
    }

    if (decision.behavior === "ask") {
      const answer = await vscode.window.showWarningMessage(
        `[${decision.ruleId}] ${decision.message}`,
        { modal: true },
        "許可",
      );
      if (answer !== "許可") {
        return { behavior: "deny" as const, message: "ユーザーが承認しなかった" };
      }
      return { behavior: "allow" as const, updatedInput: input };
    }

    // 規律を通った入力を土台に、[2] 入力を絞る。
    // 規律（deny/ask）が先。コスト削減が安全側の判断を上書きしてはいけない。
    let allowed = input;
    if (decision.updatedInput) {
      post({ type: "rule", mark: "✎", text: `${decision.appliedRules.join(", ")} が入力を補正` });
      // 絶対パスに戻して返す
      const restored = { ...decision.updatedInput };
      for (const key of ["file_path", "notebook_path", "path"]) {
        if (typeof input[key] === "string") {
          restored[key] = input[key];
        }
      }
      allowed = restored;
    }

    const narrowed = budget.planInput(toolName, allowed, (p) => fileFacts(root, p));
    if (narrowed) {
      post({ type: "rule", mark: "◧", text: narrowed.reason });
      return { behavior: "allow" as const, updatedInput: narrowed.updatedInput };
    }

    return { behavior: "allow" as const, updatedInput: allowed };
  };
}

/** ファイル変更後の後処理を走らせる。 */
function runPostHooks(root: string): void {
  const ruleSet = loadRuleSet(root);
  const deps = buildEngineDeps(root);
  for (const hook of ruleSet.post_run) {
    const result = deps.runCommand(hook.run);
    post({
      type: "rule",
      mark: result.ok ? "✓" : "✗",
      level: result.ok ? undefined : "warn",
      text: hook.run,
    });
  }
}

// ---------- Webview ----------

/** state を Webview 用の行データにする。表示の組み立ては Webview 側でやる。 */
function stateRows(state: AgentState): Array<{ key?: string; value: string; sub?: boolean }> {
  const rows: Array<{ key?: string; value: string; sub?: boolean }> = [];
  for (const [key, value] of Object.entries(state)) {
    if (key === "schema_version" || key === "active" || key === "history_mode") continue;
    if (value === null || value === undefined || value === "" || value === false) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      rows.push({ key, value: "" });
      for (const item of value) rows.push({ value: String(item), sub: true });
    } else if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) continue;
      rows.push({ key, value: "" });
      for (const [k, v] of entries) rows.push({ value: `${k}: ${String(v)}`, sub: true });
    } else {
      rows.push({ key, value: String(value) });
    }
  }
  return rows;
}

/**
 * チャットへメッセージを送る。
 *
 * 送り先はセンターのパネルだけ。以前は左サイドバーにも同じものを送っていたため、
 * 左で話すとセンターのセッションも一緒に動いて見えた（history と sessionId は
 * 元から1つなので、実体は同じ会話が2箇所に描かれていた）。
 * 左サイドバーは state グラフ専用にして、役割を分けた。
 */
function post(message: unknown): void {
  centerPanel?.webview.postMessage(message);
}

/** nonce を使って inline script を許可する。CSP が無いと VSCode は script を全部止める。 */
function nonce(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function html(webview: vscode.Webview, bundle = "webview"): string {
  const n = nonce();
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri!, "dist", `${bundle}.js`),
  );
  const style = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri!, "dist", `${bundle}.css`),
  );

  // CSP: 外部からは何も読ませない。React も CSS も dist から配る。
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${n}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${style}">
</head><body>
<div id="root"></div>
<script nonce="${n}" src="${script}"></script>
</body></html>`;
}

// ---------- 1ターン実行 ----------

async function handleSend(text: string): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    post({ type: "rule", mark: "⚠", level: "err", text: "ワークスペースが開かれていない" });
    return;
  }

  const mode = config<HistoryMode>("historyMode", "recent");
  const state = loadState(root);

  // ターンごとに作り直す。前のターンの抑止状態を持ち越さない。
  const streamFilter = new StreamFilter();

  // context 予算。3層（隔離 / 入力を絞る / 出力を削る）を1つの会計で束ねる。
  // ターンごとに作り直す（持ち回すと予算が枯れたまま次ターンに入る）。
  // canUseTool と run の両方が同じインスタンスを見るので、層をまたいだ実績が揃う。
  const budget = new ContextBudget(budgetConfig());

  // 走っている間だけ保持する。stop メッセージでこれを abort する。
  const controller = new AbortController();
  running = controller;

  try {
    const result = await run({
      state,
      instruction: text,
      mode,
      recentTurns: config("recentTurns", 3),
      history,
      cwd: root,
      sessionId,
      abortController: controller,
      budget,
      canUseTool: makeCanUseTool(root, budget) as never,
      onText: (chunk) => {
        // state フェンスは機械が読むもの。人が読む本文には出さない。
        const visible = streamFilter.push(chunk);
        if (visible !== "") {
          post({ type: "text", text: visible });
        }
      },
      onToolUse: (id, name, input) => {
        toolCards.set(id, { name });
        // 書き換え前の内容を読んでから差分を作る（実行前なのでまだ元のまま）
        const fp = typeof input.file_path === "string" ? input.file_path : null;
        let before: string | null = null;
        if (fp) {
          try {
            before = readFileSync(fp.startsWith("/") ? fp : join(root, fp), "utf8");
          } catch {
            before = null; // 新規ファイル
          }
        }
        const card = summarizeToolUse(name, input, before);
        post({ type: "tool", id, tool: name, card });
      },
      onToolResult: (id, content, isError) => {
        const entry = toolCards.get(id);
        const out = entry?.name === "Bash" ? renderBashResult(content) : undefined;
        post({ type: "toolResult", id, isError, output: out });
        toolCards.delete(id);
      },
    });

    sessionId = result.sessionId ?? sessionId;
    // 保留していた末尾を吐き出す（フェンスに入っていなければ本文の続き）。
    const tail = streamFilter.flush();
    if (tail !== "") {
      post({ type: "text", text: tail });
    }

    // 履歴に state フェンスを持ち回らせない。機械用の JSON を
    // 次ターンのプロンプトに載せるのはトークンの無駄。
    history.push({ instruction: text, response: stripStateFence(result.response) });

    const patched = result.state !== state;
    if (patched) {
      saveState(root, result.state);
      post({ type: "state", rows: stateRows(result.state) });
      postGraph(result.state);
    }

    // 引き継ぎ書として足りない点を見せる。保存は済んでいるので作業は止めない。
    // 黙って直すと「なぜ質が上がらないのか」が分からなくなるため表に出す。
    if (result.stateWarnings.length > 0) {
      post({
        type: "meta",
        text: ["state の書き方:", ...result.stateWarnings.map((w) => `・${w}`)].join("\n"),
      });
    }

    // 実測ログ。モード別の削減率を後から集計できるようにする。
    appendRunLog(
      root,
      formatRunLine(
        buildRunRecord({
          mode,
          instruction: text,
          usage: result.usage,
          statePatched: patched,
          rateLimit: result.rateLimit,
          now: new Date(),
        }),
      ),
    );

    if (result.usage) {
      const { inputTokens, outputTokens, cacheReadTokens } = result.usage;
      // キャッシュが効いているかを毎ターン見せる。0 が続くなら引き継がれていない。
      const cache = cacheReadTokens > 0 ? ` / cache ${cacheReadTokens.toLocaleString()}` : "";
      post({
        type: "meta",
        text: `[${mode}] in ${inputTokens.toLocaleString()} / out ${outputTokens.toLocaleString()}${cache} tokens`,
      });
    }

    // どの層が何を削ったかを見せる。効き目が見えないと閾値を動かせない
    // （既定値は仮置きなので人が調整する前提）。
    if (result.budgetSummary) {
      post({ type: "meta", text: result.budgetSummary });
    }

    // パッチが返らなかったターンを見せる。据え置きが無音だと取りこぼしに気づけない。
    if (!patched) {
      post({ type: "rule", mark: "○", text: "state 更新なし" });
    }

    runPostHooks(root);
  } catch (e) {
    // 中断はエラーではない。利用者が止めたのだから、そう見せる。
    if (controller.signal.aborted) {
      post({ type: "rule", mark: "■", text: "中断した" });
    } else {
      post({
        type: "rule",
        mark: "⚠",
        level: "err",
        text: e instanceof Error ? e.message : String(e),
      });
    }
  } finally {
    if (running === controller) {
      running = undefined;
    }
    post({ type: "done" });
  }
}

/** Webview からのメッセージ処理。サイドバーとセンターで共有する。 */
async function handleWebviewMessage(m: Record<string, unknown>): Promise<void> {
          if (m.type === "send" && typeof m.text === "string") {
            // 走っている最中なら積むだけ。終わったら drainQueue が拾う。
            if (running) {
              queue.push(m.text);
              post({ type: "queued", count: queue.size, items: queue.peekAll() });
              return;
            }
            await handleSend(m.text);
            await drainQueue();
          }
          if (m.type === "mode" && typeof m.mode === "string") {
            await vscode.workspace
              .getConfiguration("statefulAgent")
              .update("historyMode", m.mode, vscode.ConfigurationTarget.Workspace);
            history.length = 0;
            sessionId = undefined;
            post({ type: "meta", text: `履歴モード: ${m.mode}（履歴をクリア）` });
          }
          if (m.type === "edit") {
            const root2 = workspaceRoot();
            if (root2) {
              post({ type: "editing", text: toEditable(loadState(root2)) });
            }
          }
          if (m.type === "save" && typeof m.text === "string") {
            const root2 = workspaceRoot();
            if (root2) {
              const result = applyEdit(loadState(root2), m.text);
              if (result.ok) {
                saveState(root2, result.state);
                post({ type: "state", rows: stateRows(result.state) });
                postGraph(result.state);
                post({ type: "meta", text: "state を保存した" });
              } else {
                // 保存しない。編集中の内容は Webview 側に残す。
                post({ type: "editError", text: result.message });
              }
            }
          }
          if (m.type === "stop") {
            // 走っていなければ何もしない（二重押しで落ちないように）。
            running?.abort();
            // 待機中も捨てる。止めたのに続きが走り出すのは驚きでしかない。
            const dropped = queue.clear();
            if (dropped.length > 0) {
              post({ type: "rule", mark: "■", text: `待機中の ${dropped.length} 件も取り消した` });
              post({ type: "queued", count: 0, items: [] });
            }
          }
          if (m.type === "reset") {
            const root2 = workspaceRoot();
            if (root2) {
              saveState(root2, { ...INITIAL_STATE });
              history.length = 0;
              sessionId = undefined;
              post({ type: "state", rows: [] });
              post({ type: "meta", text: "state をリセットした" });
            }
          }
}

/**
 * 待機中の指示を順に実行する。
 *
 * 1件ずつ待って流す。並行に走らせると state の書き込みが競合し、
 * 「どちらの結果が残ったか」が不定になる。
 */
async function drainQueue(): Promise<void> {
  for (;;) {
    const next = queue.shift();
    if (next === null) {
      return;
    }
    post({ type: "queued", count: queue.size, items: queue.peekAll() });
    post({ type: "userEcho", text: next });
    await handleSend(next);
  }
}

// ---------- 拡張のライフサイクル ----------

export function activate(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("statefulAgent.graph", {
      resolveWebviewView(view) {
        graphPanel = view;
        view.webview.options = {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(extensionUri!, "dist")],
        };
        view.webview.html = html(view.webview, "graph");

        const root = workspaceRoot();
        if (root) {
          postGraph(loadState(root));
        }
        view.onDidDispose(() => {
          graphPanel = undefined;
        });
      },
    }),
    vscode.commands.registerCommand("statefulAgent.open", () => {
      void vscode.commands.executeCommand("statefulAgent.openCenter");
    }),
    vscode.commands.registerCommand("statefulAgent.openGraph", () => {
      void vscode.commands.executeCommand("statefulAgent.graph.focus");
    }),
    vscode.commands.registerCommand("statefulAgent.openCenter", () => {
      if (centerPanel) {
        centerPanel.reveal(vscode.ViewColumn.Active);
        return;
      }
      const p2 = vscode.window.createWebviewPanel(
        "statefulAgent.center",
        "Stateful Agent",
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(extensionUri!, "dist")],
        },
      );
      p2.webview.html = html(p2.webview);
      p2.webview.onDidReceiveMessage((m) => void handleWebviewMessage(m));
      p2.onDidDispose(() => {
        centerPanel = undefined;
      });
      centerPanel = p2;

      const root = workspaceRoot();
      if (root) {
        post({ type: "state", rows: stateRows(loadState(root)) });
        post({ type: "mode", mode: config<HistoryMode>("historyMode", "recent") });
        post({ type: "rules", count: loadRuleSet(root).rules.length });
      }
    }),
    vscode.commands.registerCommand("statefulAgent.setMode", async () => {
      const picked = await vscode.window.showQuickPick(["stateless", "recent", "full"], {
        title: "履歴モード",
      });
      if (picked) {
        await vscode.workspace
          .getConfiguration("statefulAgent")
          .update("historyMode", picked, vscode.ConfigurationTarget.Workspace);
        history.length = 0;
        sessionId = undefined;
      }
    }),
    vscode.commands.registerCommand("statefulAgent.showMetrics", () => {
      const root = workspaceRoot();
      if (!root) return;
      const p = runLogPath(root);
      if (!existsSync(p)) {
        void vscode.window.showInformationMessage("まだ実測ログがない");
        return;
      }
      const rows = parseRunLog(readFileSync(p, "utf8"));
      const summary = summarize(rows);
      const lines = Object.entries(summary).map(
        ([mode, s2]) =>
          `${mode}: ${s2.turns}ターン / 平均 in ${s2.avgIn.toLocaleString()} · out ${s2.avgOut.toLocaleString()}` +
          ` / cache ${Math.round(s2.cacheHitRate * 100)}%` +
          // 膨張を見せる。ヒット率だけだと「効いているのに重い」を見逃す。
          ` ${s2.firstCacheRead.toLocaleString()}→${s2.lastCacheRead.toLocaleString()}` +
          (s2.growthPerTurn > 0 ? ` (+${s2.growthPerTurn.toLocaleString()}/ターン)` : "") +
          ` / state更新率 ${Math.round(s2.patchRate * 100)}%`,
      );
      post({ type: "meta", text: lines.length > 0 ? lines.join("\n") : "ログが空" });
      void vscode.window.showInformationMessage(lines.join("  |  ") || "ログが空");
    }),
    vscode.commands.registerCommand("statefulAgent.resetState", () => {
      const root = workspaceRoot();
      if (root) {
        saveState(root, { ...INITIAL_STATE });
        history.length = 0;
        sessionId = undefined;
        post({ type: "state", rows: [] });
      }
    }),
  );
}

export function deactivate(): void {
  centerPanel = undefined;
  graphPanel = undefined;
}
