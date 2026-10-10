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
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import * as vscode from "vscode";
import type { Turn, TurnHandlers } from "./core/agent.js";
import { ModSurface, type ModSurfaceEvent } from "./core/modsurface.js";
import { startSession, type AgentSession, type FollowUpStart, type TurnEnd } from "./core/session.js";
import {
  archivedDecisions,
  DEFAULT_LEDGER_LIMITS,
  decisionsOf,
  formatArchive,
  parseArchive,
  planArchive,
  selectDetailed,
  summarizeItem,
  withArchived,
  type ArchiveEntry,
} from "./core/ledger.js";
import { judgeRelevance, warmUp } from "./core/judge.js";
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
  type PromptView,
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

/**
 * いまの CLI。人の指示ごとに起動し、ターンのあとも次の指示まで残る（mod が続きのターンを始められるように）。
 * 閉じた CLI から遅れて届いたものは、これと比べて捨てる。
 */
let session: AgentSession | undefined;
/** 待機中の指示を流している最中か。続きのターンの終わりからも流すので、二重に流さない。 */
let draining = false;

/**
 * いまの CLI につながった mod の画面要素。CLI が止まったら undefined。
 * 押されたボタンはここに渡す。前の CLI の接続から遅れて届いたものはこれと比べて捨てる。
 */
let modSurface: ModSurface | undefined;
/** CLI が画面要素を断った旨は 1 度だけ出す。毎ターン出すとうるさい。 */
let modUnavailableShown = false;

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

/** 退避した決定と未決の置き場所。state の隣に置く。 */
function archivePath(root: string): string {
  return join(dirname(statePath(root)), "archive.jsonl");
}

function loadArchive(root: string): ArchiveEntry[] {
  try {
    return parseArchive(readFileSync(archivePath(root), "utf8"));
  } catch {
    return [];
  }
}

/**
 * state を保存する。保存した state を返す。
 *
 * 保存する前に退避をかける（ledger.ts の planArchive）。決定が上限を超えたら古い確定・撤回を、
 * 解決した未決はすぐ、archive.jsonl に移す。state を有界に保ち、プロンプトに載る量を抑えるため。
 * 退避分は追記だけで、書き換えない。
 */
function saveState(root: string, state: AgentState): AgentState {
  const p = statePath(root);
  mkdirSync(dirname(p), { recursive: true });
  const { state: kept, archived } = planArchive(state, DEFAULT_LEDGER_LIMITS, new Date());
  if (archived.length > 0) {
    appendFileSync(archivePath(root), formatArchive(archived), "utf8");
  }
  writeFileSync(p, serializeState(kept), "utf8");
  return kept;
}

/**
 * state を空に戻す。退避ファイルは消さずに、日時付きの名前に変えて脇に置く。
 * 残したままだと、新しい state のグラフに前の作業の決定が混ざり、id も重なる。
 */
function resetState(root: string): void {
  const archive = archivePath(root);
  if (existsSync(archive)) {
    renameSync(archive, archive.replace(/\.jsonl$/, `.${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`));
  }
  saveState(root, { ...INITIAL_STATE });
  postGraph({ ...INITIAL_STATE });
}

/** 最後に暖機を頼んだ時刻。打つたびに投げないよう、間を空ける。 */
let lastWarm = 0;

/** 判断モデルを読み込ませておく（judge.ts の warmUp）。入力欄に打ち始めたときと、パネルを開いたときに呼ぶ。 */
function warmJudge(): void {
  const baseUrl = config("judge.baseUrl", "").trim();
  if (baseUrl === "" || Date.now() - lastWarm < 60_000) {
    return;
  }
  lastWarm = Date.now();
  void warmUp({ baseUrl, model: config("judge.model", "laya:multilingual") });
}

/** 判断モデルを呼べなかったことを、続けて何度も出さない。呼べたら戻す。 */
let judgeDownShown = false;

/**
 * 判断モデルに、今回の指示に関係する決定を選ばせる（judge.ts）。設定がなければ規則だけで載せる。
 *
 * 候補は、規則では 1 行になる決定と、退避した決定。関係すると見たものを詳しく載せる。
 */
async function planPromptView(root: string, state: AgentState, instruction: string): Promise<PromptView> {
  const baseUrl = config("judge.baseUrl", "").trim();
  if (baseUrl === "") {
    return {};
  }
  const current = decisionsOf(state);
  const detailed = selectDetailed(current, DEFAULT_LEDGER_LIMITS.recent, [], DEFAULT_LEDGER_LIMITS.detail);
  const brief = current.filter((_, i) => !detailed.has(i));
  const live = new Set(current.map((d) => d.id));
  const archived = archivedDecisions(loadArchive(root)).filter((d) => !live.has(d.id));
  const result = await judgeRelevance(
    {
      baseUrl,
      model: config("judge.model", "laya:multilingual"),
      apiKey: process.env.TYPESAFE_API_KEY,
      threshold: config("judge.threshold", 0.8),
      timeoutMs: config("judge.timeoutMs", 2000),
    },
    instruction,
    [...archived, ...brief],
  );
  if (result.error !== undefined) {
    if (!judgeDownShown) {
      judgeDownShown = true;
      post({ type: "meta", text: `判断モデル（${baseUrl}）を呼べなかった（${result.error}）。規則だけで state を載せる` });
    }
    return {};
  }
  judgeDownShown = false;
  const picked = new Set(result.ids);
  const focus = brief.map((d) => String(d.id)).filter((id) => picked.has(id));
  const recalled = archived.filter((d) => picked.has(String(d.id)));
  if (focus.length + recalled.length > 0) {
    const ids = [...focus, ...recalled.map((d) => String(d.id))];
    post({ type: "rule", mark: "◇", text: `判断モデルが関係すると見た決定を詳しく載せる: ${ids.join(", ")}` });
  }
  return { focus, recalled };
}

/** グラフビューに現在の state を送る。開いていなければ何もしない。 */
function postGraph(state: AgentState): void {
  if (!graphPanel) {
    return;
  }
  // 退避した決定も描く。グラフは決定と依存の全体を見せるもので、プロンプトの都合で欠けてはいけない
  const root = workspaceRoot();
  const whole = root ? withArchived(state, loadArchive(root)) : state;
  // postMessage は構造化クローンなので Class のメソッドは渡らない。
  // ドメインは拡張側に留め、訳し終えた描画指示だけを送る。
  const model = toRenderModel(layoutGraph(buildGraph(whole)));
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

/**
 * 規律エンジンを SDK の canUseTool に橋渡しする。
 *
 * canUseTool は CLI を起動するときに 1 度だけ渡す。CLI が自分で始めたターンでは予算を作り直すので、
 * いまのターンの予算を budget() で引く。
 */
function makeCanUseTool(root: string, budget: () => ContextBudget) {
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

    const narrowed = budget().planInput(toolName, allowed, (p) => fileFacts(root, p));
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
    if (key === "archived_ids") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      rows.push({ key, value: "" });
      // 決定は「D3 [確定] 何を」、未決は「Q2 論点（要る情報: …）」の 1 行にする
      for (const item of value) rows.push({ value: summarizeItem(key, item), sub: true });
    } else if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) continue;
      rows.push({ key, value: "" });
      for (const [k, v] of entries) rows.push({ value: `${k}: ${summarizeItem(k, v)}`, sub: true });
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

// ---------- mod の画面要素 ----------

/** 設定の CLI の場所。空なら SDK に同梱の CLI を使う。先頭の ~/ はホームに直す。 */
function claudeExecutable(): string | undefined {
  const p = config("claudeExecutable", "").trim();
  if (p === "") {
    return undefined;
  }
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/**
 * 履歴を捨てたとき（履歴モードの切り替え・state のリセット）に呼ぶ。
 *
 * 待っている CLI は前の会話を覚えているので閉じる。残すと、そこで mod が始めたターンが
 * 古い会話のまま走り、捨てたはずの履歴とリセットした state に書き込む。走っているターンは止めない。
 */
function closeIdleSession(): void {
  if (session && !session.busy) {
    session.close();
  }
}

/** ModSurface のイベントを Webview のメッセージに直す。 */
function forwardModEvent(surface: ModSurface, e: ModSurfaceEvent): void {
  if (modSurface !== surface) {
    return;
  }
  switch (e.kind) {
    case "tree":
      post({ type: "modTree", site: e.site, id: e.id, tree: e.tree });
      return;
    case "notice": {
      const n = e.notice;
      if (n.kind === "toast") post({ type: "modToast", plugin: n.plugin, text: n.text, timeoutMs: n.timeoutMs });
      if (n.kind === "status") post({ type: "modStatus", plugin: n.plugin, text: n.text });
      if (n.kind === "panes") post({ type: "modPanes", panes: n.panes, shownId: n.shownId });
      // ターミナルでは会話の流れに薄く出る 1 行。モデルには送られない
      if (n.kind === "log") post({ type: "rule", mark: "·", text: `${n.plugin}: ${n.text}` });
      return;
    }
    case "unavailable":
      if (!modUnavailableShown) {
        modUnavailableShown = true;
        post({
          type: "meta",
          text: `mod の画面要素は使えない（${e.reason}）。statefulAgent.claudeExecutable で新しい CLI を指せる`,
        });
      }
      return;
    case "closed":
      modSurface = undefined;
      post({ type: "modClear" });
      return;
    case "attached":
      return;
  }
}

// ---------- 1ターン実行 ----------

/** 1 ターン分の表示と計測の文脈。CLI が自分で始めたターンでも作り直す。 */
interface TurnContext {
  root: string;
  mode: HistoryMode;
  /** 履歴と実測ログに残す指示。CLI が始めたターンは、送り主と本文から作る。 */
  instruction: string;
  /** state フェンスを本文から外す。ターンごとに作り直す（前のターンの抑止状態を持ち越さない）。 */
  streamFilter: StreamFilter;
  /**
   * context 予算。3層（隔離 / 入力を絞る / 出力を削る）を1つの会計で束ねる。
   * ターンごとに作り直す（持ち回すと予算が枯れたまま次ターンに入る）。
   * canUseTool と出力を削るフックの両方が同じインスタンスを見るので、層をまたいだ実績が揃う。
   */
  budget: ContextBudget;
}

function newTurn(root: string, mode: HistoryMode, instruction: string): TurnContext {
  return { root, mode, instruction, streamFilter: new StreamFilter(), budget: new ContextBudget(budgetConfig()) };
}

/** CLI が自分で始めたターンを、履歴と実測ログに残す指示の形にする。 */
function followUpInstruction(start: FollowUpStart): string {
  const from = start.from ?? "CLI";
  return start.prompt ? `[${from}] ${start.prompt}` : `[${from}] （続きのターン）`;
}

/** ターンの出力を Webview に流す。 */
function turnHandlers(turn: TurnContext): TurnHandlers {
  return {
    onText: (chunk) => {
      // state フェンスは機械が読むもの。人が読む本文には出さない。
      const visible = turn.streamFilter.push(chunk);
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
          before = readFileSync(fp.startsWith("/") ? fp : join(turn.root, fp), "utf8");
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
  };
}

/**
 * ターンの後処理。人の指示のターンも、CLI が自分で始めたターンも同じ。
 *
 * state を保存し、履歴と実測ログに残し、警告と消費を見せる。最後に done を出す。
 */
function finishTurn(turn: TurnContext, controller: AbortController, end: TurnEnd): void {
  const { root, mode } = turn;
  try {
    if (!end.ok) {
      throw end.error;
    }
    const result = end.result;

    sessionId = result.sessionId ?? sessionId;
    // 保留していた末尾を吐き出す（フェンスに入っていなければ本文の続き）。
    const tail = turn.streamFilter.flush();
    if (tail !== "") {
      post({ type: "text", text: tail });
    }

    // 履歴に state フェンスを持ち回らせない。機械用の JSON を
    // 次ターンのプロンプトに載せるのはトークンの無駄。
    history.push({ instruction: turn.instruction, response: stripStateFence(result.response) });

    const patched = result.statePatched;
    if (patched) {
      const saved = saveState(root, result.state);
      post({ type: "state", rows: stateRows(saved) });
      postGraph(saved);
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
          instruction: turn.instruction,
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

async function handleSend(text: string): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    post({ type: "rule", mark: "⚠", level: "err", text: "ワークスペースが開かれていない" });
    return;
  }

  const mode = config<HistoryMode>("historyMode", "recent");
  const state = loadState(root);

  // 前の指示の CLI を閉じる。ターンのあとも残していたのは、mod が続きのターンを始められるようにするため。
  // 次の指示は新しい CLI で始めるので、履歴を持たない前提はここで保たれる
  session?.close();
  // 前の CLI の残り（帯・ステータス行など）は、新しい CLI が描き直す前に消しておく
  post({ type: "modClear" });

  // 走っている間だけ running に置く。stop メッセージでこれを abort する。
  // CLI が自分で始めたターンでも同じ controller を使う（止めると CLI ごと止まる）
  const controller = new AbortController();
  running = controller;

  // 判断モデルを待つのは running を置いてから。待つ間に送られた指示を並行に走らせず、待ち行列に入れるため
  const view = await planPromptView(root, state, text);

  const surface: ModSurface = new ModSurface({ onEvent: (e) => forwardModEvent(surface, e) });
  modSurface = surface;

  let turn = newTurn(root, mode, text);
  const s: AgentSession = startSession({
    spawnClaudeCodeProcess: surface.spawn,
    pathToClaudeCodeExecutable: claudeExecutable(),
    state,
    view,
    instruction: text,
    mode,
    recentTurns: config("recentTurns", 3),
    history,
    cwd: root,
    sessionId,
    abortController: controller,
    budget: turn.budget,
    canUseTool: makeCanUseTool(root, () => turn.budget) as never,
    ...turnHandlers(turn),
    // 続きのターンのパッチは、その時点の state に当てる（人が途中で state を編集していることがある）
    currentState: () => loadState(root),
    onFollowUpStart: (start) => {
      running = controller;
      surface.setWorking(true);
      turn = newTurn(root, mode, followUpInstruction(start));
      post({ type: "turnStart", from: start.from, text: start.prompt });
      return { handlers: turnHandlers(turn), budget: turn.budget };
    },
    onTurnEnd: (end) => {
      if (session !== s) {
        // 閉じた CLI のターンは画面に出さない。done を出すと、走っている新しいターンが終わったように見える
        return;
      }
      finishTurn(turn, controller, end);
      surface.setWorking(false);
      if (!centerPanel) {
        s.close(); // 画面がもうないので、ボタンを押す人もいない
      }
      if (end.followUp) {
        // 続きのターンの間に積まれた指示を流す。このコールバックの外で始める
        setTimeout(() => void drainQueue(), 0);
      }
    },
    onFollowUpDropped: (start) => {
      // 承認ボタンを押した直後に次の指示を送ると、ここに来る。押したのに何も起きなかった、と見えないように残す
      post({ type: "rule", mark: "○", text: `${start.from ?? "CLI"} が始めたターンは、次の指示を先にするため止めた` });
    },
    onClosed: () => {
      if (session === s) {
        session = undefined;
      }
    },
  });
  session = s;

  await s.firstTurn;
}

/**
 * Webview の初期表示（state・履歴モード・規律の数）を送る。
 *
 * Webview が読み込みを終えて ready を送ってきたときに呼ぶ。パネルを作った直後に送ると、
 * スクリプトが動く前で捨てられ、規律の数が「読み込み中」のままになっていた。
 */
function postInitial(): void {
  const root = workspaceRoot();
  if (root) {
    post({ type: "state", rows: stateRows(loadState(root)) });
    post({ type: "mode", mode: config<HistoryMode>("historyMode", "recent") });
    post({ type: "rules", count: loadRuleSet(root).rules.length });
  }
  warmJudge();
}

/** Webview からのメッセージ処理。サイドバーとセンターで共有する。 */
async function handleWebviewMessage(m: Record<string, unknown>): Promise<void> {
          if (m.type === "ready") {
            postInitial();
            return;
          }
          if (m.type === "typing") {
            warmJudge();
            return;
          }
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
            closeIdleSession();
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
                const saved = saveState(root2, result.state);
                post({ type: "state", rows: stateRows(saved) });
                postGraph(saved);
                post({ type: "meta", text: "state を保存した" });
              } else {
                // 保存しない。編集中の内容は Webview 側に残す。
                post({ type: "editError", text: result.message });
              }
            }
          }
          if (m.type === "modPress" && typeof m.plugin === "string" && typeof m.handle === "number") {
            // 人が Webview のボタンを押したときだけここに来る。push-gate の承認のように
            // 「人が押した」ことが前提の mod があるので、ほかの経路から ui_press を送らない
            if (!modSurface) {
              post({ type: "rule", mark: "○", text: "このボタンはもう押せない（描いた CLI が止まった）" });
              return;
            }
            const pressed = await modSurface.press({
              plugin: m.plugin,
              handle: m.handle,
              ...(typeof m.key === "string" ? { key: m.key } : {}),
            });
            if (!pressed) {
              post({ type: "rule", mark: "○", text: "ボタンを押せなかった。描き直したので、もう一度押してほしい" });
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
              resetState(root2);
              history.length = 0;
              sessionId = undefined;
              closeIdleSession();
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
 * 送ったあとと、CLI が自分で始めたターンのあとの両方から呼ばれるので、流している最中なら何もしない。
 */
async function drainQueue(): Promise<void> {
  if (draining) {
    return;
  }
  draining = true;
  try {
    for (;;) {
      const next = queue.shift();
      if (next === null) {
        return;
      }
      post({ type: "queued", count: queue.size, items: queue.peekAll() });
      post({ type: "userEcho", text: next });
      await handleSend(next);
    }
  } finally {
    draining = false;
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
        // 描くものは Webview の ready を待って送る。サイドバーを隠すと Webview は作り直され、また ready が来る
        view.webview.onDidReceiveMessage((m: { type?: string }) => {
          const root = workspaceRoot();
          if (m?.type === "ready" && root) {
            postGraph(loadState(root));
          }
        });
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
        // 帯のボタンを押す画面がなくなったので、待っている CLI を止める。走っているターンは終わるのを待つ（onTurnEnd で閉じる）
        closeIdleSession();
      });
      centerPanel = p2;
      // 初期表示は Webview の ready を待って送る（postInitial）
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
        closeIdleSession();
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
        resetState(root);
        history.length = 0;
        sessionId = undefined;
        closeIdleSession();
        post({ type: "state", rows: [] });
      }
    }),
  );
}

export function deactivate(): void {
  session?.close();
  session = undefined;
  centerPanel = undefined;
  graphPanel = undefined;
}
