/**
 * mod の画面要素と CLI の接続（ModSurface）のテスト。
 *
 * 本物の CLI の代わりに、stdin に書かれた制御要求へ決めた返答を返す偽のプロセスを使う。
 * 返答の形は reports/mod-surface-protocol.md の手順 1・2 で記録したもの。
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { BAND_ID, ModSurface, type ChildLike, type ModSurfaceEvent } from "../src/core/modsurface.js";

type Req = Record<string, unknown> & { subtype: string };
/** 返答を決める関数。undefined を返すと答えない。 */
type Responder = (req: Req) => { ok: unknown } | { error: string } | undefined;

class FakeCli extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** ModSurface が書いた制御要求。 */
  readonly requests: Req[] = [];

  constructor(private readonly respond: Responder) {
    super();
    createInterface({ input: this.stdin }).on("line", (line) => {
      const m = JSON.parse(line) as { type: string; request_id: string; request: Req };
      if (m.type !== "control_request") return;
      this.requests.push(m.request);
      const r = this.respond(m.request);
      if (r === undefined) return;
      const response =
        "ok" in r
          ? { subtype: "success", request_id: m.request_id, response: r.ok }
          : { subtype: "error", request_id: m.request_id, error: r.error };
      this.line({ type: "control_response", response });
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  line(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }

  /** SDK の initialize に CLI が答えた行。これを合図に ui_attach が送られる。 */
  initialized(): void {
    this.line({ type: "control_response", response: { subtype: "success", request_id: "req_1_sdk", response: {} } });
  }

  exit(): void {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }

  of(subtype: string): Req[] {
    return this.requests.filter((r) => r.subtype === subtype);
  }
}

const BAND_TREE = {
  type: "Box",
  children: [
    { type: "Text", children: ["帯"] },
    { type: "Button", props: { key: "press", label: "押す" }, press: { plugin: "probe", handle: 1 } },
  ],
};

/** CLI 2.1.289 と同じ答え方をする既定の返答。 */
const cli289: Responder = (req) => {
  switch (req.subtype) {
    case "ui_attach":
      return { ok: { surfaces: ["vscode"] } };
    case "ui_render":
      return req.component === "AbovePrompt"
        ? { ok: { tree: BAND_TREE, props: req.props, rewritten: false, hooked: true } }
        : { ok: { tree: { type: "Text", children: [`pane ${String(req.instance_id)}`] }, props: req.props, rewritten: false, hooked: true } };
    case "ui_press":
      return { ok: req.handle === 1 ? { handled: true, element: "press" } : { handled: false } };
    default:
      return undefined;
  }
};

function setup(respond: Responder = cli289) {
  const events: ModSurfaceEvent[] = [];
  const cli = new FakeCli(respond);
  const surface = new ModSurface({ onEvent: (e) => events.push(e), spawnImpl: () => cli });
  const proc = surface.spawn({ command: "claude", args: [], env: {} } as never);
  /** SDK が受け取った行。 */
  const sdkLines: string[] = [];
  createInterface({ input: proc.stdout }).on("line", (l) => sdkLines.push(l));
  return { events, cli, surface, sdkLines };
}

const trees = (events: ModSurfaceEvent[]) => events.filter((e): e is Extract<ModSurfaceEvent, { kind: "tree" }> => e.kind === "tree");

describe("ModSurface: 名乗る", () => {
  it("SDK の initialize に CLI が答えたあとで、ui_attach を isFullscreen 付きで送る", async () => {
    const { cli, sdkLines } = setup();
    // initialize の返答より前には送らない
    await new Promise((r) => setImmediate(r));
    expect(cli.of("ui_attach")).toHaveLength(0);

    cli.initialized();
    await vi.waitFor(() => expect(cli.of("ui_attach")).toHaveLength(1));
    expect(cli.of("ui_attach")[0]).toMatchObject({
      surface: "vscode",
      viewport: { columns: 100, rows: 30, isFullscreen: false },
    });
    // initialize の返答は SDK に渡る
    await vi.waitFor(() => expect(sdkLines.some((l) => l.includes("req_1_sdk"))).toBe(true));
  });

  it("自分の要求への返答は SDK に渡さない", async () => {
    const { cli, events, sdkLines } = setup();
    cli.initialized();
    await vi.waitFor(() => expect(events.some((e) => e.kind === "attached")).toBe(true));
    expect(sdkLines.some((l) => l.includes("stateful_agent_ui_"))).toBe(false);
  });

  it("CLI が ui_attach を断ったら unavailable を出し、ui_render は送らない", async () => {
    const { cli, events } = setup((req) =>
      req.subtype === "ui_attach" ? { error: "Unsupported control request subtype: ui_attach" } : cli289(req),
    );
    cli.initialized();
    await vi.waitFor(() =>
      expect(events).toContainEqual({ kind: "unavailable", reason: "Unsupported control request subtype: ui_attach" }),
    );
    expect(cli.of("ui_render")).toHaveLength(0);
  });
});

describe("ModSurface: 描く", () => {
  it("名乗れたら帯を描き、木を tree イベントで出す", async () => {
    const { cli, events } = setup();
    cli.initialized();
    await vi.waitFor(() => expect(trees(events)).toHaveLength(1));
    expect(cli.of("ui_render")[0]).toMatchObject({ component: "AbovePrompt", instance_id: BAND_ID, surface: "vscode" });
    expect(trees(events)[0]).toEqual({ kind: "tree", site: "band", id: BAND_ID, tree: BAND_TREE });
  });

  it("mod が CLI に任せた帯（engine）は tree:null", async () => {
    const { cli, events } = setup((req) =>
      req.subtype === "ui_render" ? { ok: { tree: { type: "engine", ref: 1 }, hooked: true } } : cli289(req),
    );
    cli.initialized();
    await vi.waitFor(() => expect(trees(events)).toHaveLength(1));
    expect(trees(events)[0]?.tree).toBeNull();
  });

  it("ui_invalidate で名指しされた帯を描き直す", async () => {
    const { cli, events } = setup();
    cli.initialized();
    await vi.waitFor(() => expect(trees(events)).toHaveLength(1));

    cli.line({
      type: "system",
      subtype: "ui_invalidate",
      event: "ui.render",
      instances: [{ surface: "vscode", component: "AbovePrompt", instance_id: BAND_ID }],
    });
    await vi.waitFor(() => expect(trees(events)).toHaveLength(2));
    expect(cli.of("ui_render")).toHaveLength(2);
  });

  it("ペインが開いたら描き、閉じたら tree:null を出す", async () => {
    const { cli, events } = setup();
    cli.initialized();
    await vi.waitFor(() => expect(trees(events)).toHaveLength(1));

    cli.line({ type: "system", subtype: "ui_panes", panes: [{ id: "p1", title: "ペイン", plugin: "probe" }], shown_id: "p1" });
    await vi.waitFor(() =>
      expect(trees(events)).toContainEqual({ kind: "tree", site: "pane", id: "p1", tree: { type: "Text", children: ["pane p1"] } }),
    );
    expect(cli.of("ui_render").at(-1)).toMatchObject({ component: "Pane", instance_id: "p1", props: { title: "ペイン" } });

    cli.line({ type: "system", subtype: "ui_panes", panes: [], shown_id: null });
    await vi.waitFor(() => expect(trees(events)).toContainEqual({ kind: "tree", site: "pane", id: "p1", tree: null }));
  });

  it("名乗る前に届いたペインは、名乗れたあとで描く", async () => {
    const { cli, events } = setup();
    cli.line({ type: "system", subtype: "ui_panes", panes: [{ id: "early", title: "早い", plugin: "probe" }], shown_id: "early" });
    cli.initialized();
    await vi.waitFor(() => expect(trees(events).some((e) => e.site === "pane" && e.id === "early")).toBe(true));
  });
});

describe("ModSurface: 通知と押す", () => {
  it("トーストは SDK にも渡し、notice イベントにも出す", async () => {
    const { cli, events, sdkLines } = setup();
    cli.line({ type: "system", subtype: "ui_toast", plugin: "probe", text: "やあ", timeout_ms: 4000 });
    await vi.waitFor(() =>
      expect(events).toContainEqual({ kind: "notice", notice: { kind: "toast", plugin: "probe", text: "やあ", timeoutMs: 4000 } }),
    );
    expect(sdkLines.some((l) => l.includes("ui_toast"))).toBe(true);
  });

  it("press は ui_press を送り、押せたら true", async () => {
    const { cli, events, surface } = setup();
    cli.initialized();
    await vi.waitFor(() => expect(trees(events)).toHaveLength(1));

    await expect(surface.press({ plugin: "probe", handle: 1, key: "press" })).resolves.toBe(true);
    expect(cli.of("ui_press")[0]).toMatchObject({ plugin: "probe", handle: 1, key: "press", surface: "vscode" });
  });

  it("古い handle で断られたら false を返し、描き直す", async () => {
    const { cli, events, surface } = setup();
    cli.initialized();
    await vi.waitFor(() => expect(trees(events)).toHaveLength(1));

    await expect(surface.press({ plugin: "probe", handle: 99, key: "press" })).resolves.toBe(false);
    await vi.waitFor(() => expect(cli.of("ui_render")).toHaveLength(2));
  });

  it("名乗る前は押さない", async () => {
    const { cli, surface } = setup();
    await expect(surface.press({ plugin: "probe", handle: 1 })).resolves.toBe(false);
    expect(cli.of("ui_press")).toHaveLength(0);
  });

  it("CLI が止まったら closed を出し、それ以降は押さない", async () => {
    const { cli, events, surface } = setup();
    cli.initialized();
    await vi.waitFor(() => expect(trees(events)).toHaveLength(1));

    cli.exit();
    expect(events.at(-1)).toEqual({ kind: "closed" });
    await expect(surface.press({ plugin: "probe", handle: 1 })).resolves.toBe(false);
  });

  it("答えを待っている間に CLI が止まっても、待ちは終わる", async () => {
    const { cli, events, surface } = setup((req) => (req.subtype === "ui_press" ? undefined : cli289(req)));
    cli.initialized();
    await vi.waitFor(() => expect(trees(events)).toHaveLength(1));

    const pressing = surface.press({ plugin: "probe", handle: 1 });
    await vi.waitFor(() => expect(cli.of("ui_press")).toHaveLength(1));
    cli.exit();
    await expect(pressing).resolves.toBe(false);
  });
});
