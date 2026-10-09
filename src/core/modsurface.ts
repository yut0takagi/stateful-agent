/**
 * mod の画面要素を stateful-agent に出すための、CLI との接続。
 *
 * SDK の `spawnClaudeCodeProcess` で CLI の起動を差し替え、SDK と同じ stdin・stdout に相乗りする。
 *
 * - stdin:  SDK の書き込みの合間に ui_attach / ui_render / ui_press の制御要求を書く（どちらも 1 行ずつ書く）
 * - stdout: 自分が送った要求への返答だけを抜き取り、残りはそのまま SDK に渡す。
 *           トーストなどの通知は SDK にも渡る（SDK は知らない subtype を読み流す）
 *
 * CLI は人の指示ごとに起動し、ターンのあとも次の指示まで残る（session.ts）。
 * なので画面要素はターンのあとも押せる。push-gate の承認ボタンはターンが終わってから押される。
 * CLI が止まったら closed を出し、画面側は消す。
 *
 * ui_press は人がボタンを押したときだけ呼ぶ。push-gate の承認のように「人が押した」ことが
 * 前提の mod があるので、モデルや自動処理からは呼ばない。
 */

import { spawn as nodeSpawn } from "node:child_process";
import { Transform, type Readable, type Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk" with { "resolution-mode": "import" };
import { routeLine, treeOf, type ControlResponse, type UiElement, type UiNotice, type UiPane, type UiPressRef } from "./modui.js";

/** 名乗る画面。CLI は vscode 用の要素表（Box・Text・Button など）で mod に描かせる。 */
const SURFACE = "vscode";
/** 自分が振る request_id の頭。SDK の request_id と衝突しない文字列にする。 */
const OWN_PREFIX = "stateful_agent_ui_";
/** 帯（プロンプトの上）の instance_id。CLI の側で決まっている。 */
export const BAND_ID = "above-prompt";

export type ModSurfaceEvent =
  /** CLI が ui_attach を受け付けた。 */
  | { kind: "attached" }
  /** CLI が ui_attach を断った（古い版など）。この接続では画面要素を出さない。 */
  | { kind: "unavailable"; reason: string }
  /** トースト・ステータス行・ログ・ペインの一覧。 */
  | { kind: "notice"; notice: Exclude<UiNotice, { kind: "invalidate" }> }
  /** 帯かペインの中身。null は「描くものがない」（mod が CLI に任せた、ペインが閉じた）。 */
  | { kind: "tree"; site: "band" | "pane"; id: string; tree: UiElement | null }
  /** CLI が止まった。画面要素はもう押せない。 */
  | { kind: "closed" };

/** テストで本物の CLI の代わりに差し込むプロセス。ChildProcess はこの形を満たす。 */
export interface ChildLike {
  stdin: Writable | null;
  stdout: Readable | null;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export type SpawnImpl = (
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; stdio: ["pipe", "pipe", "ignore"] },
) => ChildLike;

export interface ModSurfaceOptions {
  onEvent: (event: ModSurfaceEvent) => void;
  /** 画面の大きさ（文字のマス）。mod が折り返しを決めるのに使う。 */
  viewport?: { columns: number; rows: number };
  clientId?: string;
  /** テスト用。省略すると node:child_process の spawn を使う。 */
  spawnImpl?: SpawnImpl;
}

type Site = { component: "AbovePrompt" } | { component: "Pane"; id: string };

export class ModSurface {
  private child: ChildLike | undefined;
  private phase: "waiting" | "attaching" | "attached" | "unavailable" | "closed" = "waiting";
  private seq = 0;
  private readonly pending = new Map<string, (r: ControlResponse | null) => void>();
  private panes: UiPane[] = [];
  /** 描いている途中の部品と、その間に古くなった部品。同じ部品の ui_render を重ねて送らない。 */
  private readonly rendering = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly viewport: { columns: number; rows: number };
  private readonly clientId: string;
  /** ターンが走っているか。帯の props（isWorking）で mod に伝える。CLI はターンを始めるときに起動する。 */
  private working = true;

  constructor(private readonly opts: ModSurfaceOptions) {
    this.viewport = opts.viewport ?? { columns: 100, rows: 30 };
    this.clientId = opts.clientId ?? "stateful-agent";
  }

  /** SDK の `spawnClaudeCodeProcess` に渡す。1 つの ModSurface につき 1 回だけ呼ばれる想定。 */
  readonly spawn = (options: SpawnOptions): SpawnedProcess => {
    const spawnImpl: SpawnImpl = this.opts.spawnImpl ?? ((c, a, o) => nodeSpawn(c, a, o));
    const child = spawnImpl(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      // SDK が渡す signal は stdin を閉じて猶予を置いたあとに切れるので、spawn に渡してよい（SDK の型注記）
      signal: options.signal,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    child.on("exit", () => this.onExit());

    const stdout = this.filterStdout(child.stdout);
    return {
      stdin: child.stdin as Writable,
      stdout,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill: (signal) => child.kill(signal),
      on: ((event: string, listener: (...args: any[]) => void) => void child.on(event, listener)) as SpawnedProcess["on"],
      once: ((event: string, listener: (...args: any[]) => void) => void child.once(event, listener)) as SpawnedProcess["once"],
      off: ((event: string, listener: (...args: any[]) => void) => void child.off(event, listener)) as SpawnedProcess["off"],
    };
  };

  /**
   * 人が押したボタンを CLI に伝える。押せたかを返す。
   *
   * handle は描くたびに変わり、古い木の handle は断られる（実測）。
   * 断られたら手元の木が古いので、描いている部品をすべて描き直す。
   */
  async press(ref: UiPressRef & { key?: string }): Promise<boolean> {
    if (this.phase !== "attached") {
      return false;
    }
    const r = await this.control({
      subtype: "ui_press",
      plugin: ref.plugin,
      handle: ref.handle,
      ...(ref.key ? { key: ref.key } : {}),
      surface: SURFACE,
      client_id: this.clientId,
    });
    const handled = r?.subtype === "success" && (r.response as { handled?: unknown } | undefined)?.handled === true;
    if (!handled) {
      this.renderAll();
    }
    return handled;
  }

  /** ターンの始まりと終わりを伝える。変わったら帯を描き直す（isWorking を見て描き分ける mod がある）。 */
  setWorking(working: boolean): void {
    if (this.working === working) {
      return;
    }
    this.working = working;
    if (this.phase === "attached") {
      this.render({ component: "AbovePrompt" });
    }
  }

  // ---------- stdout ----------

  private filterStdout(source: Readable | null): Readable {
    const decoder = new StringDecoder("utf8");
    let buf = "";
    const out = new Transform({
      transform: (chunk: Buffer | string, _enc, done) => {
        buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (this.onLine(line)) {
            out.push(line + "\n");
          }
        }
        done();
      },
      flush: (done) => {
        const rest = buf + decoder.end();
        if (rest !== "" && this.onLine(rest)) {
          out.push(rest);
        }
        done();
      },
    });
    source?.pipe(out);
    return out;
  }

  /** 1 行を処理し、SDK に渡すかを返す。 */
  private onLine(line: string): boolean {
    const routed = routeLine(line, OWN_PREFIX);
    switch (routed.kind) {
      case "own": {
        const resolve = this.pending.get(routed.response.request_id);
        this.pending.delete(routed.response.request_id);
        resolve?.(routed.response);
        return false;
      }
      case "notice":
        this.onNotice(routed.notice);
        return true;
      case "response":
        // SDK の最初の制御要求（initialize）に CLI が答えたら、画面として名乗る
        if (this.phase === "waiting") {
          void this.attach();
        }
        return true;
      default:
        return true;
    }
  }

  private onNotice(notice: UiNotice): void {
    if (notice.kind === "invalidate") {
      if (this.phase !== "attached") {
        return;
      }
      if (!notice.instances) {
        this.renderAll();
        return;
      }
      for (const i of notice.instances) {
        if (i.surface !== "" && i.surface !== SURFACE) {
          continue;
        }
        if (i.component === "AbovePrompt") {
          this.render({ component: "AbovePrompt" });
        } else if (i.component === "Pane" && this.panes.some((p) => p.id === i.instanceId)) {
          this.render({ component: "Pane", id: i.instanceId });
        }
      }
      return;
    }

    if (notice.kind === "panes") {
      const before = new Set(this.panes.map((p) => p.id));
      const after = new Set(notice.panes.map((p) => p.id));
      this.panes = notice.panes;
      for (const id of before) {
        if (!after.has(id)) {
          this.opts.onEvent({ kind: "tree", site: "pane", id, tree: null });
        }
      }
      this.opts.onEvent({ kind: "notice", notice });
      if (this.phase === "attached") {
        for (const p of notice.panes) {
          if (!before.has(p.id)) {
            this.render({ component: "Pane", id: p.id });
          }
        }
      }
      return;
    }

    this.opts.onEvent({ kind: "notice", notice });
  }

  // ---------- 制御要求 ----------

  private async attach(): Promise<void> {
    this.phase = "attaching";
    const r = await this.control({
      subtype: "ui_attach",
      surface: SURFACE,
      client_id: this.clientId,
      // isFullscreen を入れると「ペインを置く画面」として数えられる。入れないとペインが保留される（実測）
      viewport: { ...this.viewport, isFullscreen: false },
    });
    if (this.phase !== "attaching") {
      return;
    }
    if (r?.subtype !== "success") {
      this.phase = "unavailable";
      this.opts.onEvent({ kind: "unavailable", reason: r?.subtype === "error" ? r.error : "CLI が答えなかった" });
      return;
    }
    this.phase = "attached";
    this.opts.onEvent({ kind: "attached" });
    this.renderAll();
  }

  private renderAll(): void {
    if (this.phase !== "attached") {
      return;
    }
    this.render({ component: "AbovePrompt" });
    for (const p of this.panes) {
      this.render({ component: "Pane", id: p.id });
    }
  }

  /** 部品を 1 つ描く。描いている途中に頼まれたら、終わってからもう一度だけ描く。 */
  private render(site: Site): void {
    const key = site.component === "AbovePrompt" ? site.component : `Pane:${site.id}`;
    if (this.rendering.has(key)) {
      this.dirty.add(key);
      return;
    }
    this.rendering.add(key);
    void (async () => {
      try {
        do {
          this.dirty.delete(key);
          await this.renderOnce(site);
        } while (this.dirty.has(key) && this.phase === "attached");
      } finally {
        this.rendering.delete(key);
      }
    })();
  }

  private async renderOnce(site: Site): Promise<void> {
    const pane = site.component === "Pane" ? this.panes.find((p) => p.id === site.id) : undefined;
    if (site.component === "Pane" && !pane) {
      return; // 頼む前に閉じた
    }
    const id = site.component === "Pane" ? site.id : BAND_ID;
    const r = await this.control({
      subtype: "ui_render",
      surface: SURFACE,
      client_id: this.clientId,
      component: site.component,
      instance_id: id,
      props: pane ? this.paneProps(pane) : this.bandProps(),
      viewport: { ...this.viewport, isFullscreen: false },
    });
    if (this.phase !== "attached") {
      return;
    }
    if (site.component === "Pane" && !this.panes.some((p) => p.id === site.id)) {
      return; // 描いている間に閉じた
    }
    const tree = r?.subtype === "success" ? treeOf(r.response) : null;
    this.opts.onEvent({ kind: "tree", site: site.component === "Pane" ? "pane" : "band", id, tree });
  }

  /** 帯の props。型は CLI の `AbovePrompt` の props（すべて読み取り専用）。 */
  private bandProps(): Record<string, unknown> {
    const maxRows = 10;
    return {
      hasSurvey: false,
      isWorking: this.working,
      maxRows,
      // 右端の 5 マスは CLI の印（[-]）の場所として空ける決まり
      bodyColumns: this.viewport.columns - 5,
      scroll: { offset: 0, bodyRows: maxRows - 1 },
      view: {},
    };
  }

  private paneProps(pane: UiPane): Record<string, unknown> {
    return {
      title: pane.title,
      isFocused: false,
      bodyColumns: this.viewport.columns - 2,
      placement: "inline",
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    };
  }

  /** 制御要求を 1 つ送り、返答を待つ。送れない・CLI が止まったときは null。 */
  private control(request: Record<string, unknown>): Promise<ControlResponse | null> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.writableEnded || stdin.destroyed || this.phase === "closed") {
      return Promise.resolve(null);
    }
    const request_id = `${OWN_PREFIX}${++this.seq}`;
    return new Promise((resolve) => {
      this.pending.set(request_id, resolve);
      stdin.write(JSON.stringify({ type: "control_request", request_id, request }) + "\n");
    });
  }

  private onExit(): void {
    if (this.phase === "closed") {
      return;
    }
    this.phase = "closed";
    for (const resolve of this.pending.values()) {
      resolve(null);
    }
    this.pending.clear();
    this.opts.onEvent({ kind: "closed" });
  }
}
