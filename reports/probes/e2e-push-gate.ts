// mod-surface-protocol.md の手順 3 段階 B: stateful-agent の startSession + ModSurface を、本物の SDK・CLI・push-gate で通しで動かす
//
// 使い方（リポジトリの根で）:
//   ./node_modules/.bin/esbuild reports/probes/e2e-push-gate.ts --bundle --platform=node --format=esm --outfile=<出力>.mjs
//   node <出力>.mjs <claude バイナリ> <push-gate のフォルダ>
//
// 一時フォルダに git リポジトリと push 先の bare リポジトリを作り、その中だけで push する。
// 人がボタンを押す代わりに、このスクリプトが帯の「承認」を ModSurface.press() で押す（確認用。拡張では人の操作だけが押す）。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ContextBudget } from "../../src/core/contextbudget.js";
import { ModSurface } from "../../src/core/modsurface.js";
import type { UiElement } from "../../src/core/modui.js";
import { startSession } from "../../src/core/session.js";
import { INITIAL_STATE } from "../../src/core/state.js";

const [cliArg, pushGateArg] = process.argv.slice(2);
if (!cliArg || !pushGateArg) {
  console.error("usage: node e2e-push-gate.mjs <claude> <push-gate-dir>");
  process.exit(2);
}
// CLI は一時フォルダで起動するので、相対パスのままだと見つからない
const CLI = resolve(cliArg);
const PUSH_GATE = resolve(pushGateArg);
// バンドルには SDK を入れず、リポジトリの node_modules から読む（リポジトリの根で動かす）
const sdkPath = join(process.cwd(), "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");
const sdk = (await import(sdkPath)) as { query: (p: unknown) => AsyncIterable<unknown> & { close(): void } };

const base = mkdtempSync(join(tmpdir(), "e2e-push-gate-"));
const cwd = join(base, "work");
const remote = join(base, "remote.git");
const git = (args: string[], dir = cwd) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
mkdirSync(cwd);
execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
git(["init", "-q", "-b", "main"]);
git(["config", "user.email", "e2e@example.invalid"]);
git(["config", "user.name", "e2e"]);
writeFileSync(join(cwd, "README.md"), "e2e\n");
git(["add", "README.md"]);
git(["commit", "-q", "-m", "e2e"]);
git(["remote", "add", "origin", remote]);
const remoteMain = () => {
  try {
    return git(["--git-dir", remote, "log", "--oneline", "main"], base);
  } catch {
    return "(なし)";
  }
};

const t0 = Date.now();
const log = (s: string) => console.log(`[${String(Date.now() - t0).padStart(6)}ms] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findButton(node: unknown, key: string): { plugin: string; handle: number; key: string } | null {
  if (!node || typeof node !== "object") return null;
  const el = node as UiElement;
  if (el.type === "Button" && el.props?.key === key && el.press) return { ...el.press, key };
  for (const c of el.children ?? []) {
    const found = findButton(c, key);
    if (found) return found;
  }
  return null;
}

// 入れ子の Claude Code だと判断されないよう、親セッションの印を外す
const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" };
for (const key of Object.keys(env)) {
  if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_SSE") || key === "CLAUDE_CODE_IDE_HOST_OVERRIDE") delete env[key];
}

let band: UiElement | null = null;
let firstEnded = false;
let pressed = false;

const surface: ModSurface = new ModSurface({
  onEvent: (e) => {
    if (e.kind === "tree") {
      log(`surface: tree ${e.site}/${e.id} ${JSON.stringify(e.tree).slice(0, 140)}`);
      if (e.site === "band") {
        band = e.tree;
        void maybePress();
      }
    } else if (e.kind === "notice") {
      log(`surface: notice ${JSON.stringify(e.notice)}`);
    } else {
      log(`surface: ${e.kind}${"reason" in e ? ` ${e.reason}` : ""}`);
    }
  },
});

// 人がボタンを押す代わり。人の指示のターンが終わってから押す
async function maybePress() {
  if (!firstEnded || pressed || !band) return;
  const b = findButton(band, "approve");
  if (!b) return;
  pressed = true;
  log(`承認を押す: ${JSON.stringify(b)}`);
  log(`press → ${await surface.press(b)}`);
}

let followUpDone!: () => void;
const followUpEnded = new Promise<void>((r) => (followUpDone = r));
let closedDone!: () => void;
const closed = new Promise<void>((r) => (closedDone = r));
const permissions: string[] = [];
const handlers = (tag: string) => ({
  onToolUse: (_id: string, name: string, input: Record<string, unknown>) => log(`${tag} tool_use ${name} ${JSON.stringify(input)}`),
  onToolResult: (_id: string, content: string, isError: boolean) => log(`${tag} tool_result ${isError ? "[error] " : ""}${content.slice(0, 120).replace(/\n/g, " ")}`),
});

const session = startSession({
  spawnClaudeCodeProcess: surface.spawn,
  pathToClaudeCodeExecutable: CLI,
  state: INITIAL_STATE,
  instruction:
    "Bash ツールで `git push origin main` を 1 回だけ実行してください。ほかのコマンドは実行しないでください。拒否されたら、その理由を 1 文で伝えて終えてください。",
  mode: "stateless",
  recentTurns: 0,
  history: [],
  cwd,
  budget: new ContextBudget(),
  canUseTool: (async (name: string, input: Record<string, unknown>) => {
    permissions.push(`${name} ${JSON.stringify(input)}`);
    log(`canUseTool ${name} ${JSON.stringify(input)}`);
    return { behavior: "allow", updatedInput: input };
  }) as never,
  ...handlers("[人]"),
  currentState: () => INITIAL_STATE,
  onFollowUpStart: (start) => {
    log(`followUpStart ${JSON.stringify(start)}`);
    surface.setWorking(true);
    return { handlers: handlers("[続き]"), budget: new ContextBudget() };
  },
  onTurnEnd: (end) => {
    log(
      `turnEnd followUp=${end.followUp} ok=${end.ok} ` +
        (end.ok ? `patched=${end.result.statePatched} usage=${JSON.stringify(end.result.usage)} response=${JSON.stringify(end.result.response.slice(0, 100))}` : String(end.error)),
    );
    surface.setWorking(false);
    if (!end.followUp) {
      firstEnded = end.ok;
      void maybePress();
    } else {
      followUpDone();
    }
  },
  onClosed: () => {
    log("session: closed");
    closedDone();
  },
  queryImpl: (p) =>
    sdk.query({
      prompt: p.prompt,
      options: { ...p.options, model: "haiku", settingSources: ["project"], plugins: [{ type: "local", path: PUSH_GATE }], env },
    }),
});

await session.firstTurn;
log(`人の指示のターンのあと: busy=${session.busy} / remote の main: ${remoteMain()}`);
if (!firstEnded) {
  log("人の指示のターンが失敗したので、ここで止める");
  process.exit(1);
}

const got = await Promise.race([followUpEnded.then(() => "ended"), sleep(180_000).then(() => "timeout")]);
log(`続きのターン: ${got} / remote の main: ${remoteMain()}`);

await sleep(1500);
log("次の指示が来た想定で close()");
session.close();
const c = await Promise.race([closed.then(() => "closed"), sleep(20_000).then(() => "timeout")]);
log(`close のあと: ${c} / busy=${session.busy}`);
log(`canUseTool に来た呼び出し: ${permissions.length} 件`);
await sleep(500);
process.exit(0);
