import { describe, expect, it } from "vitest";
import {
  applyEdit,
  applyPatch,
  dedupeIds,
  buildPrompt,
  extractPatch,
  isEmpty,
  parseState,
  renderState,
  StreamFilter,
  stripStateFence,
  toEditable,
  validatePatch,
  type AgentState,
} from "../src/core/state.js";

describe("parseState", () => {
  it("壊れた JSON では初期状態に落ちる（作業を止めない）", () => {
    expect(parseState("not json")).toEqual({ schema_version: 1, active: false });
  });

  it("配列を渡されても初期状態に落ちる", () => {
    expect(parseState("[1,2,3]")).toEqual({ schema_version: 1, active: false });
  });

  it("既存のキーを保つ", () => {
    const s = parseState('{"active":true,"やりたいこと":"X"}');
    expect(s.active).toBe(true);
    expect(s["やりたいこと"]).toBe("X");
  });
});

describe("isEmpty", () => {
  it("空とみなす値", () => {
    for (const v of [null, undefined, "", [], {}, false]) {
      expect(isEmpty(v)).toBe(true);
    }
  });

  it("空でない値", () => {
    for (const v of ["a", [1], { a: 1 }, true, 0]) {
      expect(isEmpty(v)).toBe(false);
    }
  });
});

describe("applyPatch", () => {
  const base: AgentState = { schema_version: 1, active: true, 決まったこと: ["A"] };

  it("キーを追加・更新する", () => {
    const next = applyPatch(base, { 未決: ["B"], 決まったこと: ["A", "C"] });
    expect(next["未決"]).toEqual(["B"]);
    expect(next["決まったこと"]).toEqual(["A", "C"]);
  });

  it("null でキーを削除する（論文の規約）", () => {
    const next = applyPatch(base, { 決まったこと: null });
    expect("決まったこと" in next).toBe(false);
  });

  it("元の state を破壊しない", () => {
    applyPatch(base, { 決まったこと: null });
    expect(base["決まったこと"]).toEqual(["A"]);
  });
});

describe("extractPatch", () => {
  it("state フェンスから取り出す", () => {
    const text = 'やりました。\n\n```state\n{"未決": null}\n```\n';
    expect(extractPatch(text)).toEqual({ 未決: null });
  });

  it("フェンスが無ければ null", () => {
    expect(extractPatch("ただの応答")).toBeNull();
  });

  it("壊れた JSON なら null（応答全体を捨てない）", () => {
    expect(extractPatch("```state\n{壊れてる\n```")).toBeNull();
  });
});

describe("renderState", () => {
  it("空の項目と制御キーを落とす", () => {
    const rendered = renderState({
      schema_version: 1,
      active: true,
      history_mode: "recent",
      やりたいこと: "X",
      未決: [],
    });
    expect(rendered).toBe("- **やりたいこと**: X");
  });

  it("中身が無ければ null", () => {
    expect(renderState({ schema_version: 1, active: true })).toBeNull();
  });

  it("配列と辞書を展開する", () => {
    const rendered = renderState({
      schema_version: 1,
      active: true,
      決まったこと: ["A", "B"],
      メモ: { 出典: "arXiv" },
    });
    expect(rendered).toContain("    - A");
    expect(rendered).toContain("    - 出典: arXiv");
  });
});

describe("buildPrompt", () => {
  const state: AgentState = { schema_version: 1, active: true, やりたいこと: "X" };

  it("stateless では履歴が入らない", () => {
    const p = buildPrompt(state, "日報を作って", []);
    expect(p).toContain("現在の作業 state");
    expect(p).toContain("日報を作って");
    expect(p).not.toContain("直近のやり取り");
  });

  it("recent では直近ターンが入る", () => {
    const p = buildPrompt(state, "続けて", ["user: A", "assistant: B"]);
    expect(p).toContain("直近のやり取り");
    expect(p).toContain("user: A");
  });

  it("state が空でも指示は必ず入る", () => {
    const p = buildPrompt({ schema_version: 1, active: false }, "やって", []);
    expect(p).not.toContain("現在の作業 state");
    expect(p).toContain("やって");
  });

  it("パッチの出し方を必ず伝える", () => {
    expect(buildPrompt(state, "X", [])).toContain("```state");
  });
});

// ---- state インスペクタ（手編集）----

describe("toEditable", () => {
  it("制御キーを外して編集用 JSON にする", () => {
    const s: AgentState = { schema_version: 1, active: true, やりたいこと: "X" };
    expect(JSON.parse(toEditable(s))).toEqual({ やりたいこと: "X" });
  });

  it("空の state では空オブジェクトになる", () => {
    expect(JSON.parse(toEditable({ schema_version: 1, active: false }))).toEqual({});
  });

  it("末尾に改行を付ける（エディタで編集しやすい）", () => {
    expect(toEditable({ schema_version: 1, active: false })).toMatch(/\n$/);
  });
});

describe("applyEdit", () => {
  const base: AgentState = { schema_version: 1, active: true, 古いキー: "v" };

  it("編集内容で置き換える（パッチではなく全置換）", () => {
    const r = applyEdit(base, '{"新しいキー":"w"}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state["新しいキー"]).toBe("w");
    expect("古いキー" in r.state).toBe(false);
  });

  it("制御キーは編集で失わない", () => {
    const r = applyEdit(base, "{}");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.schema_version).toBe(1);
    expect(r.state.active).toBe(true);
  });

  it("壊れた JSON は拒否する（state を壊さない）", () => {
    const r = applyEdit(base, "{ not json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBeTruthy();
  });

  it("配列は拒否する", () => {
    expect(applyEdit(base, "[1,2]").ok).toBe(false);
  });

  it("編集で制御キーを書いても無視する（乗っ取らせない）", () => {
    const r = applyEdit(base, '{"schema_version":99,"active":false,"x":1}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.schema_version).toBe(1);
    expect(r.state.active).toBe(true);
    expect(r.state.x).toBe(1);
  });
});

describe("validatePatch", () => {
  it("決定レコードが揃っていれば警告なし", () => {
    const w = validatePatch({
      決定: [
        {
          何を: "manifest 探索順を3段にした",
          前提: ["vault にのみ vault設計/ がある"],
          却下: "候補へのフォールバック（設定ミスが埋もれる）",
          行動: "resolveManifestPath を追加",
          検証: "mutation test で破壊を捕まえた",
          状態: "確定",
        },
      ],
    });
    expect(w).toEqual([]);
  });

  it("決定の理由（前提・却下）が無ければ警告する", () => {
    const w = validatePatch({
      決定: [{ 何を: "3段にした", 行動: "実装した", 状態: "確定" }],
    });
    expect(w.join("\n")).toMatch(/前提/);
  });

  it("行動だけ書いて決定の中身が無ければ警告する", () => {
    const w = validatePatch({ 決定: [{ 行動: "実装した" }] });
    expect(w.join("\n")).toMatch(/何を/);
  });

  it("決定が配列でなければ警告する", () => {
    const w = validatePatch({ 決定: "3段にした" });
    expect(w.join("\n")).toMatch(/配列/);
  });

  it("やったことの羅列だけ（決定が無い）なら警告する", () => {
    const w = validatePatch({ やったこと: ["実装した", "テストした"] });
    expect(w.join("\n")).toMatch(/決定/);
  });

  it("未決に論点が無ければ警告する", () => {
    const w = validatePatch({
      決定: [{ 何を: "x", 前提: ["y"], 行動: "z", 状態: "確定" }],
      未決: [{ メモ: "あとで考える" }],
    });
    expect(w.join("\n")).toMatch(/論点/);
  });

  it("削除パッチ（null）は検証対象にしない", () => {
    expect(validatePatch({ 決定: null })).toEqual([]);
  });

  it("状態が語彙外なら警告する", () => {
    const w = validatePatch({
      決定: [{ 何を: "x", 前提: ["y"], 行動: "z", 状態: "たぶん" }],
    });
    expect(w.join("\n")).toMatch(/状態/);
  });

  it("空のパッチは警告しない（state 据え置きは正常）", () => {
    expect(validatePatch({})).toEqual([]);
  });
});

describe("stripStateFence", () => {
  it("state フェンスを本文から除く", () => {
    const r = stripStateFence(
      ["作業した。", "```state", '{ "決定": [] }', "```"].join("\n"),
    );
    expect(r).not.toMatch(/```state/);
    expect(r).toContain("作業した。");
  });

  it("フェンスの前後の余分な空行を残さない", () => {
    const r = stripStateFence(["本文。", "", "```state", "{}", "```", ""].join("\n"));
    expect(r).toBe("本文。");
  });

  it("state フェンスが無ければそのまま返す", () => {
    expect(stripStateFence("ただの応答")).toBe("ただの応答");
  });

  it("他の言語のコードブロックは消さない", () => {
    const src = ["```ts", "const a = 1;", "```"].join("\n");
    expect(stripStateFence(src)).toBe(src);
  });

  it("state フェンスだけの応答は空になる", () => {
    expect(stripStateFence(["```state", "{}", "```"].join("\n"))).toBe("");
  });

  it("本文が state フェンスを挟んでいても前後を繋ぐ", () => {
    const r = stripStateFence(
      ["前half", "```state", "{}", "```", "後half"].join("\n"),
    );
    expect(r).toContain("前half");
    expect(r).toContain("後half");
    expect(r).not.toMatch(/```/);
  });
});

describe("StreamFilter — ストリーミング中に state フェンスを出さない", () => {
  it("通常のテキストはそのまま通す", () => {
    const f = new StreamFilter();
    expect(f.push("こんにちは")).toBe("こんにちは");
  });

  it("フェンスが始まったらそれ以降を通さない", () => {
    const f = new StreamFilter();
    expect(f.push("作業した。\n")).toBe("作業した。\n");
    f.push("```state\n");
    expect(f.push('{ "決定": [] }')).toBe("");
    expect(f.push("\n```")).toBe("");
  });

  it("チャンクの途中でフェンスが始まっても手前だけ通す", () => {
    const f = new StreamFilter();
    expect(f.push("本文\n```state\n{}")).toBe("本文\n");
  });

  it("バッククォートが分割されて届いても取りこぼさない", () => {
    const f = new StreamFilter();
    expect(f.push("本文")).toBe("本文");
    // ``` が 1文字ずつ来るケース
    f.push("`");
    f.push("`");
    f.push("`");
    f.push("state\n");
    expect(f.push("{}")).toBe("");
  });

  it("state 以外のコードブロックは通す", () => {
    const f = new StreamFilter();
    const out = f.push("```ts\nconst a = 1;\n```");
    expect(out).toContain("const a = 1;");
  });

  it("フェンスを閉じた後の本文も通さない（末尾が前提）", () => {
    const f = new StreamFilter();
    f.push("```state\n{}\n```\n");
    expect(f.push("余談")).toBe("");
  });
});

describe("applyPatch — 配列の部分更新（out を減らすため）", () => {
  const base: AgentState = {
    schema_version: 1,
    active: false,
    決定: [
      { id: "D1", 何を: "1つ目", 状態: "確定" },
      { id: "D2", 何を: "2つ目", 状態: "暫定" },
    ],
  };

  it("「決定+」は末尾に追記する（既存は書き直さない）", () => {
    const next = applyPatch(base, { "決定+": [{ id: "D3", 何を: "3つ目" }] });
    const list = next["決定"] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(3);
    expect(list[2].id).toBe("D3");
    // 既存はそのまま
    expect(list[0].何を).toBe("1つ目");
  });

  it("「決定~」は id が一致する要素を置き換える", () => {
    const next = applyPatch(base, {
      "決定~": [{ id: "D2", 何を: "2つ目", 状態: "撤回" }],
    });
    const list = next["決定"] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    expect(list[1].状態).toBe("撤回");
    expect(list[0].何を).toBe("1つ目");
  });

  it("「決定~」で id が見つからなければ追記として扱う（取りこぼさない）", () => {
    const next = applyPatch(base, { "決定~": [{ id: "D9", 何を: "新顔" }] });
    const list = next["決定"] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(3);
    expect(list[2].id).toBe("D9");
  });

  it("追記と更新を同時に出せる", () => {
    const next = applyPatch(base, {
      "決定~": [{ id: "D1", 何を: "1つ目", 状態: "撤回" }],
      "決定+": [{ id: "D3", 何を: "3つ目" }],
    });
    const list = next["決定"] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(3);
    expect(list[0].状態).toBe("撤回");
    expect(list[2].id).toBe("D3");
  });

  it("元の配列を壊さない（参照を共有しない）", () => {
    applyPatch(base, { "決定+": [{ id: "D3" }] });
    expect((base["決定"] as unknown[]).length).toBe(2);
  });

  it("対象キーが無いときは新しく作る", () => {
    const next = applyPatch({ schema_version: 1, active: false }, {
      "決定+": [{ id: "D1", 何を: "初回" }],
    });
    expect(next["決定"]).toHaveLength(1);
  });

  it("既存が配列でないときは置き換える（壊れた state から復帰する）", () => {
    const broken: AgentState = { schema_version: 1, active: false, 決定: "文字列" };
    const next = applyPatch(broken, { "決定+": [{ id: "D1" }] });
    expect(Array.isArray(next["決定"])).toBe(true);
    expect(next["決定"]).toHaveLength(1);
  });

  it("未決でも同じ規約が使える（決定専用にしない）", () => {
    const s: AgentState = {
      schema_version: 1,
      active: false,
      未決: [{ id: "O1", 論点: "古い" }],
    };
    const next = applyPatch(s, { "未決+": [{ id: "O2", 論点: "新しい" }] });
    expect(next["未決"]).toHaveLength(2);
  });

  it("サフィックス付きのキー自体は state に残さない", () => {
    const next = applyPatch(base, { "決定+": [{ id: "D3" }] });
    expect("決定+" in next).toBe(false);
    expect("決定~" in next).toBe(false);
  });

  it("id を持たない要素は追記として扱う", () => {
    const next = applyPatch(base, { "決定~": [{ 何を: "id なし" }] });
    expect(next["決定"]).toHaveLength(3);
  });

  it("従来の全置換も引き続き動く", () => {
    const next = applyPatch(base, { 決定: [{ id: "X", 何を: "全部入れ替え" }] });
    expect(next["決定"]).toHaveLength(1);
  });
});

describe("validatePatch — 部分更新にも効く", () => {
  it("「決定+」も決定として検証する（誤警告しない）", () => {
    const w = validatePatch({
      "決定+": [
        { 何を: "x", 前提: ["y"], 行動: "z", 状態: "確定" },
      ],
    });
    expect(w).toEqual([]);
  });

  it("「決定+」で理由がなければ警告する", () => {
    const w = validatePatch({ "決定+": [{ 何を: "x", 行動: "z" }] });
    expect(w.join("\n")).toMatch(/前提/);
  });

  it("「決定~」も検証対象", () => {
    const w = validatePatch({ "決定~": [{ 何を: "x", 行動: "z" }] });
    expect(w.join("\n")).toMatch(/前提/);
  });

  it("部分更新があれば「決定がない」とは言わない", () => {
    const w = validatePatch({ "決定+": [{ 何を: "x", 前提: ["y"], 行動: "z" }] });
    expect(w.join("\n")).not.toMatch(/「決定」がない/);
  });

  it("「未決+」の論点も検証する", () => {
    const w = validatePatch({
      "決定+": [{ 何を: "x", 前提: ["y"], 行動: "z" }],
      "未決+": [{ メモ: "論点がない" }],
    });
    expect(w.join("\n")).toMatch(/論点/);
  });
});

describe("applyPatch — id の衝突（履歴を持たないので採番が重複する）", () => {
  const base: AgentState = {
    schema_version: 1,
    active: false,
    決定: [{ id: "D6", 何を: "先にあった決定", 状態: "確定" }],
  };

  it("同じ id で追記されたら別 id を振って両方残す", () => {
    const next = applyPatch(base, {
      "決定+": [{ id: "D6", 何を: "別セッションの決定", 状態: "確定" }],
    });
    const list = next["決定"] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    // 先にあったものは変わらない
    expect(list[0].id).toBe("D6");
    expect(list[0].何を).toBe("先にあった決定");
    // 後から来たものは別の id になる
    expect(list[1].id).not.toBe("D6");
    expect(list[1].何を).toBe("別セッションの決定");
  });

  it("一意化した id は元の id が分かる形にする", () => {
    const next = applyPatch(base, { "決定+": [{ id: "D6", 何を: "後" }] });
    const list = next["決定"] as Array<Record<string, unknown>>;
    expect(String(list[1].id)).toMatch(/^D6/);
  });

  it("3つ目が来ても衝突しない", () => {
    const one = applyPatch(base, { "決定+": [{ id: "D6", 何を: "2番目" }] });
    const two = applyPatch(one, { "決定+": [{ id: "D6", 何を: "3番目" }] });
    const list = two["決定"] as Array<Record<string, unknown>>;
    const ids = list.map((x) => x.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("更新（決定~）は衝突扱いにしない（差し替えたいのだから）", () => {
    const next = applyPatch(base, {
      "決定~": [{ id: "D6", 何を: "差し替え", 状態: "撤回" }],
    });
    const list = next["決定"] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0].何を).toBe("差し替え");
  });

  it("id を持たない追記はそのまま通す", () => {
    const next = applyPatch(base, { "決定+": [{ 何を: "id なし" }] });
    expect(next["決定"]).toHaveLength(2);
  });

  it("同じパッチ内で重複しても両方残る", () => {
    const next = applyPatch(base, {
      "決定+": [
        { id: "D9", 何を: "A" },
        { id: "D9", 何を: "B" },
      ],
    });
    const list = next["決定"] as Array<Record<string, unknown>>;
    expect(list).toHaveLength(3);
    expect(new Set(list.map((x) => x.id)).size).toBe(3);
  });
});

describe("dedupeIds — 既に重複している state を直す", () => {
  it("重複した id を振り直す（後から来たほうを変える）", () => {
    const s: AgentState = {
      schema_version: 1,
      active: false,
      決定: [
        { id: "D6", 何を: "先" },
        { id: "D7", 何を: "他" },
        { id: "D6", 何を: "後" },
      ],
    };
    const fixed = dedupeIds(s);
    const list = fixed["決定"] as Array<Record<string, unknown>>;
    expect(list[0].id).toBe("D6");
    expect(list[0].何を).toBe("先");
    expect(list[2].id).toBe("D6-2");
    expect(list[2].何を).toBe("後");
  });

  it("既に -2 が使われていれば -3 にする", () => {
    const s: AgentState = {
      schema_version: 1,
      active: false,
      決定: [{ id: "D6" }, { id: "D6-2" }, { id: "D6" }],
    };
    const list = dedupeIds(s)["決定"] as Array<Record<string, unknown>>;
    expect(list[2].id).toBe("D6-3");
  });

  it("重複がなければそのまま", () => {
    const s: AgentState = {
      schema_version: 1,
      active: false,
      決定: [{ id: "D1" }, { id: "D2" }],
    };
    const list = dedupeIds(s)["決定"] as Array<Record<string, unknown>>;
    expect(list.map((x) => x.id)).toEqual(["D1", "D2"]);
  });

  it("未決も対象にする", () => {
    const s: AgentState = {
      schema_version: 1,
      active: false,
      未決: [{ id: "O1" }, { id: "O1" }],
    };
    const list = dedupeIds(s)["未決"] as Array<Record<string, unknown>>;
    expect(new Set(list.map((x) => x.id)).size).toBe(2);
  });

  it("id を持たない要素は触らない", () => {
    const s: AgentState = {
      schema_version: 1,
      active: false,
      決定: [{ 何を: "id なし" }, { 何を: "これも" }],
    };
    const list = dedupeIds(s)["決定"] as Array<Record<string, unknown>>;
    expect(list.every((x) => !("id" in x))).toBe(true);
  });

  it("元の state を壊さない", () => {
    const s: AgentState = {
      schema_version: 1,
      active: false,
      決定: [{ id: "D6" }, { id: "D6" }],
    };
    dedupeIds(s);
    const list = s["決定"] as Array<Record<string, unknown>>;
    expect(list[1].id).toBe("D6");
  });

  it("配列でないキーは無視する", () => {
    const s: AgentState = { schema_version: 1, active: false, 目的: "文字列" };
    expect(() => dedupeIds(s)).not.toThrow();
  });
});
