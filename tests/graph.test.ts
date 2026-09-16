import { describe, expect, it } from "vitest";
import { buildGraph, clipToWidth, layoutGraph, toRenderModel } from "../src/core/graph.js";
import type { AgentState } from "../src/core/state.js";
import {
  Decision,
  OpenQuestion,
  Premise,
  RejectedOption,
  Verification,
} from "../src/domain/nodes.js";

const base = { schema_version: 1, active: false } as const;

function state(extra: Record<string, unknown>): AgentState {
  return { ...base, ...extra };
}

describe("buildGraph", () => {
  it("決定と前提をノードにし、前提→決定のエッジを張る", () => {
    const g = buildGraph(
      state({
        決定: [{ 何を: "3段探索にした", 前提: ["vault のみ独自パス"], 行動: "実装", 状態: "確定" }],
      }),
    );
    expect(g.nodes.some((n) => n instanceof Decision)).toBe(true);
    expect(g.nodes.some((n) => n instanceof Premise)).toBe(true);

    const premise = g.nodes.find((n) => n instanceof Premise);
    const decision = g.nodes.find((n) => n instanceof Decision);
    expect(g.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: premise!.id, to: decision!.id, label: "前提" }),
      ]),
    );
  });

  it("同じ前提は1ノードに畳み、複数の決定へエッジを張る", () => {
    const g = buildGraph(
      state({
        決定: [
          { 何を: "A", 前提: ["共通の前提"], 行動: "a", 状態: "確定" },
          { 何を: "B", 前提: ["共通の前提"], 行動: "b", 状態: "確定" },
        ],
      }),
    );
    const premises = g.nodes.filter((n) => n instanceof Premise);
    expect(premises).toHaveLength(1);
    expect(g.edges.filter((e) => e.from === premises[0].id)).toHaveLength(2);
  });

  it("却下案は決定からのエッジで示す", () => {
    const g = buildGraph(
      state({ 決定: [{ 何を: "A", 却下: "案B", 行動: "a", 状態: "確定" }] }),
    );
    const rejected = g.nodes.find((n) => n instanceof RejectedOption);
    expect(rejected?.label).toBe("案B");
    const decision = g.nodes.find((n) => n instanceof Decision);
    expect(g.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: decision!.id, to: rejected!.id, label: "却下" }),
      ]),
    );
  });

  it("撤回された決定にも印を残す（消さない）", () => {
    const g = buildGraph(
      state({ 決定: [{ 何を: "誤った判断", 前提: ["x"], 行動: "a", 状態: "撤回" }] }),
    );
    const d = g.nodes.find((n) => n instanceof Decision) as Decision;
    expect(d.decisionState).toBe("撤回");
  });

  it("未決はノードにし、論点を表示する", () => {
    const g = buildGraph(
      state({ 未決: [{ 論点: "recent の N", 要る情報: "実測" }] }),
    );
    const open = g.nodes.find((n) => n instanceof OpenQuestion);
    expect(open?.label).toBe("recent の N");
  });

  it("検証をノードにして決定から張る", () => {
    const g = buildGraph(
      state({ 決定: [{ 何を: "A", 前提: ["x"], 行動: "a", 検証: "mutation test", 状態: "確定" }] }),
    );
    const v = g.nodes.find((n) => n instanceof Verification);
    expect(v?.label).toBe("mutation test");
  });

  it("空の state では空のグラフ", () => {
    const g = buildGraph(state({}));
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it("台帳型でない state（やったことの羅列）でも落ちない", () => {
    const g = buildGraph(state({ やったこと: ["実装した"] }));
    expect(g.nodes).toEqual([]);
  });

  it("決定が文字列でも落ちない", () => {
    expect(() => buildGraph(state({ 決定: "文字列" }))).not.toThrow();
  });

  it("ノード id は一意", () => {
    const g = buildGraph(
      state({
        決定: [
          { 何を: "A", 前提: ["p1", "p2"], 却下: "r", 検証: "v", 行動: "a", 状態: "確定" },
          { 何を: "B", 前提: ["p2", "p3"], 却下: "r2", 検証: "v2", 行動: "b", 状態: "暫定" },
        ],
        未決: [{ 論点: "o1" }],
      }),
    );
    const ids = g.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("layoutGraph", () => {
  const g = buildGraph(
    state({
      決定: [
        { 何を: "A", 前提: ["p1"], 却下: "r1", 検証: "v1", 行動: "a", 状態: "確定" },
        { 何を: "B", 前提: ["p1", "p2"], 行動: "b", 状態: "暫定" },
      ],
      未決: [{ 論点: "o1" }],
    }),
  );

  it("全ノードに座標を与える", () => {
    const l = layoutGraph(g);
    expect(l.nodes).toHaveLength(g.nodes.length);
    for (const n of l.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("種類ごとに列を分ける（前提は決定より左）", () => {
    const l = layoutGraph(g);
    const premise = l.nodes.find((n) => n.node instanceof Premise)!;
    const decision = l.nodes.find((n) => n.node instanceof Decision)!;
    expect(premise.x).toBeLessThan(decision.x);
  });

  it("却下案と検証は決定より右", () => {
    const l = layoutGraph(g);
    const decision = l.nodes.find((n) => n.node instanceof Decision)!;
    const rejected = l.nodes.find((n) => n.node instanceof RejectedOption)!;
    expect(rejected.x).toBeGreaterThan(decision.x);
  });

  it("同じ列のノードは縦に重ならない", () => {
    const l = layoutGraph(g);
    const premises = l.nodes.filter((n) => n.node instanceof Premise);
    const ys = premises.map((n) => n.y);
    expect(new Set(ys).size).toBe(ys.length);
  });

  it("描画領域の大きさを返す", () => {
    const l = layoutGraph(g);
    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBeGreaterThan(0);
  });

  it("空のグラフでも落ちない", () => {
    const l = layoutGraph({ nodes: [], edges: [] });
    expect(l.nodes).toEqual([]);
    expect(l.width).toBeGreaterThan(0);
  });
});

describe("グラフはドメインのノードで構成される", () => {
  it("ノードはドメインの Class インスタンス", () => {
    const g = buildGraph(
      state({ 決定: [{ 何を: "A", 前提: ["p"], 行動: "a", 状態: "確定" }] }),
    );
    expect(g.nodes.some((n) => n instanceof Premise)).toBe(true);
    expect(g.nodes.some((n) => n instanceof Decision)).toBe(true);
  });

  it("ノードは自分の役割を答えられる", () => {
    const g = buildGraph(state({ 決定: [{ 何を: "A", 前提: ["p"], 行動: "a" }] }));
    const roles = g.nodes.map((n) => n.role);
    expect(roles).toContain("grounding");
    expect(roles).toContain("conclusion");
  });

  it("エッジの述語はノード自身が決めている", () => {
    const g = buildGraph(
      state({ 決定: [{ 何を: "A", 前提: ["p"], 却下: "r", 行動: "a" }] }),
    );
    const premise = g.nodes.find((n) => n instanceof Premise)!;
    const decision = g.nodes.find((n) => n instanceof Decision)!;
    const edge = g.edges.find((e) => e.from === premise.id && e.to === decision.id)!;
    expect(edge.label).toBe(premise.predicateTo(decision));
  });

  it("レイアウトの列はノードの layer から決まる", () => {
    const g = buildGraph(
      state({ 決定: [{ 何を: "A", 前提: ["p"], 却下: "r", 行動: "a" }] }),
    );
    const l = layoutGraph(g);
    const premise = l.nodes.find((n) => n.node instanceof Premise)!;
    const decision = l.nodes.find((n) => n.node instanceof Decision)!;
    expect(premise.x).toBeLessThan(decision.x);
  });

  it("撤回された決定は visual.invalidated が立つ", () => {
    const g = buildGraph(state({ 決定: [{ 何を: "誤り", 前提: ["x"], 行動: "a", 状態: "撤回" }] }));
    const d = g.nodes.find((n) => n instanceof Decision) as Decision;
    expect(d.visual.invalidated).toBe(true);
  });
});

describe("toRenderModel — 転送可能な描画モデルに訳す", () => {
  const g = buildGraph(
    state({
      決定: [
        { 何を: "A", 前提: ["p1"], 却下: "r1", 検証: "v1", 行動: "aした", 状態: "暫定" },
      ],
      未決: [{ 論点: "o1", 要る情報: "実測" }],
    }),
  );

  it("メソッドを持たないプレーンな値になる（postMessage は構造化クローン）", () => {
    const m = toRenderModel(layoutGraph(g));
    // JSON 往復で情報が落ちないこと = 転送しても壊れない
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it("役割と描画意図を持ち回る", () => {
    const m = toRenderModel(layoutGraph(g));
    const decision = m.nodes.find((n) => n.role === "conclusion")!;
    expect(decision.emphasis).toBe("central");
    expect(decision.contour).toBe("tentative");
    expect(decision.invalidated).toBe(false);
  });

  it("分類名を持ち回る（View が日本語キーを知らなくていい）", () => {
    const m = toRenderModel(layoutGraph(g));
    expect(m.nodes.map((n) => n.kindLabel)).toContain("前提");
  });

  it("ツールチップ用の補足も持つ", () => {
    const m = toRenderModel(layoutGraph(g));
    const decision = m.nodes.find((n) => n.role === "conclusion")!;
    expect(decision.detail).toBe("aした");
  });

  it("未決の「要る情報」も補足に載る", () => {
    const m = toRenderModel(layoutGraph(g));
    const open = m.nodes.find((n) => n.role === "inquiry")!;
    expect(open.detail).toBe("実測");
  });

  it("座標と大きさをそのまま渡す", () => {
    const l = layoutGraph(g);
    const m = toRenderModel(l);
    expect(m.width).toBe(l.width);
    expect(m.nodes[0].x).toBe(l.nodes[0].x);
  });

  it("CSS の色値は持たない（色は View が決める）", () => {
    const m = toRenderModel(layoutGraph(g));
    expect(JSON.stringify(m)).not.toMatch(/#[0-9a-f]{3}|var\(--|rgb\(/i);
  });
});

describe("決定同士の依存（横に進む）", () => {
  it("依存に挙げた決定からエッジを張る", () => {
    const g = buildGraph(
      state({
        決定: [
          { id: "D1", 何を: "3段探索にした", 前提: ["p"], 行動: "a" },
          { id: "D2", 何を: "警告のみにした", 依存: ["D1"], 行動: "b" },
        ],
      }),
    );
    const d1 = g.nodes.find((n) => n.label === "3段探索にした")!;
    const d2 = g.nodes.find((n) => n.label === "警告のみにした")!;
    expect(g.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: d1.id, to: d2.id, label: "前提" }),
      ]),
    );
  });

  it("依存された決定は依存する決定より左に来る", () => {
    const l = layoutGraph(
      buildGraph(
        state({
          決定: [
            { id: "D1", 何を: "先の決定", 前提: ["p"], 行動: "a" },
            { id: "D2", 何を: "後の決定", 依存: ["D1"], 行動: "b" },
          ],
        }),
      ),
    );
    const d1 = l.nodes.find((n) => n.node.label === "先の決定")!;
    const d2 = l.nodes.find((n) => n.node.label === "後の決定")!;
    expect(d1.x).toBeLessThan(d2.x);
  });

  it("3連鎖では層が3段に分かれる", () => {
    const l = layoutGraph(
      buildGraph(
        state({
          決定: [
            { id: "A", 何を: "1つ目", 前提: ["p"], 行動: "a" },
            { id: "B", 何を: "2つ目", 依存: ["A"], 行動: "b" },
            { id: "C", 何を: "3つ目", 依存: ["B"], 行動: "c" },
          ],
        }),
      ),
    );
    const xs = ["1つ目", "2つ目", "3つ目"].map(
      (label) => l.nodes.find((n) => n.node.label === label)!.x,
    );
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
  });

  it("依存のない決定は同じ層に並ぶ", () => {
    const l = layoutGraph(
      buildGraph(
        state({
          決定: [
            { id: "A", 何を: "独立1", 前提: ["p"], 行動: "a" },
            { id: "B", 何を: "独立2", 前提: ["q"], 行動: "b" },
          ],
        }),
      ),
    );
    const a = l.nodes.find((n) => n.node.label === "独立1")!;
    const b = l.nodes.find((n) => n.node.label === "独立2")!;
    expect(a.x).toBe(b.x);
    expect(a.y).not.toBe(b.y);
  });

  it("存在しない id への依存は無視する", () => {
    const g = buildGraph(
      state({ 決定: [{ id: "D1", 何を: "x", 依存: ["存在しない"], 行動: "a" }] }),
    );
    expect(g.edges).toEqual([]);
  });

  it("循環依存でも落ちない", () => {
    const s = state({
      決定: [
        { id: "A", 何を: "a", 依存: ["B"], 行動: "x" },
        { id: "B", 何を: "b", 依存: ["A"], 行動: "y" },
      ],
    });
    expect(() => layoutGraph(buildGraph(s))).not.toThrow();
  });

  it("id を書かない決定でも従来通り動く", () => {
    const g = buildGraph(
      state({ 決定: [{ 何を: "id なし", 前提: ["p"], 行動: "a" }] }),
    );
    expect(g.nodes.some((n) => n.label === "id なし")).toBe(true);
  });
});

describe("却下・検証は親の決定に追随する", () => {
  const deep = () =>
    layoutGraph(
      buildGraph(
        state({
          決定: [
            { id: "A", 何を: "1つ目", 前提: ["p"], 行動: "a", 却下: "却下A" },
            { id: "B", 何を: "2つ目", 依存: ["A"], 行動: "b" },
            { id: "C", 何を: "3つ目", 依存: ["B"], 行動: "c", 検証: "テストC" },
          ],
        }),
      ),
    );

  it("深い依存の決定の検証は、その決定より右に来る", () => {
    const l = deep();
    const c = l.nodes.find((n) => n.node.label === "3つ目")!;
    const v = l.nodes.find((n) => n.node.label === "テストC")!;
    expect(v.x).toBeGreaterThan(c.x);
  });

  it("浅い決定の却下は、その決定より右に来る", () => {
    const l = deep();
    const a = l.nodes.find((n) => n.node.label === "1つ目")!;
    const r = l.nodes.find((n) => n.node.label === "却下A")!;
    expect(r.x).toBeGreaterThan(a.x);
  });

  it("浅い決定の却下は、深い決定より左に来る（親の位置に従う）", () => {
    const l = deep();
    const r = l.nodes.find((n) => n.node.label === "却下A")!;
    const c = l.nodes.find((n) => n.node.label === "3つ目")!;
    expect(r.x).toBeLessThan(c.x);
  });
});

describe("clipToWidth — 枠からはみ出さないように切る", () => {
  it("半角は2倍入る（全角と幅が違う）", () => {
    // 予算10単位から省略記号(全角=1)を引いて9単位 → 半角は0.5単位なので18文字入る
    expect(clipToWidth("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghijklmnopqr…");
  });

  it("日本語は文字数ではなく幅で切る", () => {
    // 全角は1文字で1単位。10単位なら9文字＋省略記号
    const r = clipToWidth("あいうえおかきくけこさしすせそ", 10);
    expect(r).toBe("あいうえおかきくけ…");
  });

  it("収まるものはそのまま返す", () => {
    expect(clipToWidth("短い", 10)).toBe("短い");
    expect(clipToWidth("short", 10)).toBe("short");
  });

  it("全角と半角が混ざっても幅で判定する", () => {
    // "テスト" = 3単位, "abc" = 1.5単位 → 4.5単位で 10 に収まる
    expect(clipToWidth("テストabc", 10)).toBe("テストabc");
  });

  it("空文字は空のまま", () => {
    expect(clipToWidth("", 10)).toBe("");
  });

  it("幅ゼロなら省略記号だけ", () => {
    expect(clipToWidth("あいう", 0)).toBe("…");
  });
});
