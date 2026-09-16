/**
 * ドメイン層のテスト。
 *
 * 「ノードは自分が前提なのか結論なのかを知っている」ことを検証する。
 * 呼び出し側が種類を判定して分岐しなくてよい状態を目標にする。
 */

import { describe, expect, it } from "vitest";
import {
  Decision,
  OpenQuestion,
  Premise,
  RejectedOption,
  Verification,
  nodeFromLedger,
  type StateNode,
} from "../src/domain/nodes.js";

describe("ノードは自分の役割を知っている", () => {
  it("前提は根拠づけの役割", () => {
    expect(new Premise("p1", "vault のみ独自パス").role).toBe("grounding");
  });

  it("決定は結論の役割", () => {
    expect(new Decision("d1", "3段探索にした").role).toBe("conclusion");
  });

  it("却下案は対案の役割", () => {
    expect(new RejectedOption("r1", "候補フォールバック").role).toBe("alternative");
  });

  it("検証は裏付けの役割", () => {
    expect(new Verification("v1", "mutation test").role).toBe("evidence");
  });

  it("未決は問いの役割", () => {
    expect(new OpenQuestion("o1", "recent の N").role).toBe("inquiry");
  });
});

describe("ノードは接続の妥当性を判断できる", () => {
  const premise = new Premise("p1", "x");
  const decision = new Decision("d1", "y");
  const rejected = new RejectedOption("r1", "z");
  const verification = new Verification("v1", "w");

  it("前提は決定を支えられる", () => {
    expect(premise.canPrecede(decision)).toBe(true);
  });

  it("前提は却下案を支えない（却下案は決定から伸びる）", () => {
    expect(premise.canPrecede(rejected)).toBe(false);
  });

  it("決定は却下案を持てる", () => {
    expect(decision.canPrecede(rejected)).toBe(true);
  });

  it("決定は検証を持てる", () => {
    expect(decision.canPrecede(verification)).toBe(true);
  });

  it("決定は前提を支えない（向きが逆）", () => {
    expect(decision.canPrecede(premise)).toBe(false);
  });

  it("検証から先には何も伸びない", () => {
    expect(verification.canPrecede(decision)).toBe(false);
  });
});

describe("ノードは述語を知っている", () => {
  it("前提→決定の述語は「前提」", () => {
    expect(new Premise("p", "x").predicateTo(new Decision("d", "y"))).toBe("前提");
  });

  it("決定→却下案の述語は「却下」", () => {
    expect(new Decision("d", "x").predicateTo(new RejectedOption("r", "y"))).toBe("却下");
  });

  it("決定→検証の述語は「検証」", () => {
    expect(new Decision("d", "x").predicateTo(new Verification("v", "y"))).toBe("検証");
  });

  it("繋がらない組み合わせでは述語がない", () => {
    expect(new Verification("v", "x").predicateTo(new Decision("d", "y"))).toBeNull();
  });
});

describe("描画意図はノードが持つ（具体的な色は持たない）", () => {
  it("前提は補助的な強調", () => {
    expect(new Premise("p", "x").visual.emphasis).toBe("supporting");
  });

  it("決定は中心的な強調", () => {
    expect(new Decision("d", "x").visual.emphasis).toBe("central");
  });

  it("確定した決定は輪郭が閉じている", () => {
    expect(new Decision("d", "x", "確定").visual.contour).toBe("solid");
  });

  it("暫定の決定は輪郭が開いている（覆せることを示す）", () => {
    expect(new Decision("d", "x", "暫定").visual.contour).toBe("tentative");
  });

  it("撤回された決定は無効の印がつく", () => {
    const v = new Decision("d", "x", "撤回").visual;
    expect(v.invalidated).toBe(true);
  });

  it("状態を書かない決定は確定として扱う", () => {
    expect(new Decision("d", "x").visual.contour).toBe("solid");
  });

  it("ドメインは CSS の色値を持たない", () => {
    const v = new Decision("d", "x").visual;
    expect(JSON.stringify(v)).not.toMatch(/#|var\(|rgb/);
  });
});

describe("ノードは自分の分類名を答えられる", () => {
  it("表示用のラベルを持つ", () => {
    expect(new Premise("p", "x").kindLabel).toBe("前提");
    expect(new Decision("d", "x").kindLabel).toBe("決定");
    expect(new OpenQuestion("o", "x").kindLabel).toBe("未決");
  });

  it("同じ役割のノードは同じ層に属する", () => {
    const a: StateNode = new RejectedOption("r", "x");
    const b: StateNode = new Verification("v", "y");
    expect(a.layer).toBe(b.layer);
  });

  it("前提は決定より前の層", () => {
    expect(new Premise("p", "x").layer).toBeLessThan(new Decision("d", "y").layer);
  });
});

describe("nodeFromLedger — 台帳の語彙からノードを作る", () => {
  it("台帳のキー名を知っているのはこの関数だけ", () => {
    const n = nodeFromLedger("前提", "p1", "vault のみ");
    expect(n).toBeInstanceOf(Premise);
  });

  it("未知のキーでは作らない", () => {
    expect(nodeFromLedger("やったこと", "x1", "実装した")).toBeNull();
  });

  it("決定は状態も受け取る", () => {
    const n = nodeFromLedger("決定", "d1", "3段探索", "暫定");
    expect((n as Decision).visual.contour).toBe("tentative");
  });
});
