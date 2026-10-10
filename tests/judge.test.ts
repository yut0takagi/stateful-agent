/**
 * 判断モデルに関係する決定を選ばせる（judge.ts）のテスト。
 *
 * 形は TypeSafe の /v1/systemone に合わせた。本物の Ollaya 0.12.0（laya）で、
 * model が必須なこと（省くと HTTP 422）と、answers.<名前>.noul で確率が返ることを確かめた。Jev では確かめていない。
 */

import { describe, expect, it } from "vitest";
import { buildRequest, isLocal, judgeRelevance, parseAnswers, warmUp } from "../src/core/judge.js";

const config = { baseUrl: "http://localhost:11435/", model: "laya", threshold: 0.5, timeoutMs: 200 };
const decisions = [
  { id: "D1", 何を: "push 先は origin", 状態: "確定" },
  { id: "D2", 何を: "README を直す", 状態: "確定" },
];

function fakeFetch(answers: Record<string, unknown>, status = 200) {
  const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
  const impl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, init });
    return { ok: status === 200, status, json: async () => ({ model: "laya", answers }) };
  };
  return { calls, impl: impl as never };
}

describe("buildRequest", () => {
  it("決定ごとに Noul の質問を作り、名前は q0, q1, … にする", () => {
    const { body, names } = buildRequest("laya", "push して", decisions);
    expect(body.model).toBe("laya");
    expect(body.state).toBe("指示: push して");
    expect(body.questions).toMatchObject({
      q0: { type: "noul", criteria: { true: expect.any(String), false: expect.any(String) } },
      q1: { type: "noul" },
    });
    expect((body.questions as Record<string, { instructions: string }>).q0.instructions).toContain("D1 [確定] push 先は origin");
    expect([...names]).toEqual([
      ["q0", "D1"],
      ["q1", "D2"],
    ]);
  });
});

describe("parseAnswers", () => {
  it("noul の確率を取り出し、形の違う答えは捨てる", () => {
    expect(parseAnswers({ answers: { q0: { type: "noul", noul: 0.9 }, q1: { type: "choice", choice: "x" }, q2: null } })).toEqual({ q0: 0.9 });
    expect(parseAnswers({})).toEqual({});
  });
});

describe("judgeRelevance", () => {
  it("閾値以上の決定の id を返す", async () => {
    const f = fakeFetch({ q0: { type: "noul", noul: 0.91 }, q1: { type: "noul", noul: 0.12 } });
    const r = await judgeRelevance(config, "push して", decisions, f.impl);
    expect(r).toEqual({ ids: ["D1"], probabilities: { D1: 0.91, D2: 0.12 } });
    expect(f.calls[0]?.url).toBe("http://localhost:11435/v1/systemone");
    expect(f.calls[0]?.init.headers.authorization).toBeUndefined();
  });

  it("API キーがあれば Bearer で渡す", async () => {
    const f = fakeFetch({});
    await judgeRelevance({ ...config, apiKey: "k" }, "x", decisions, f.impl);
    expect(f.calls[0]?.init.headers.authorization).toBe("Bearer k");
  });

  it("接続先が空なら呼ばない", async () => {
    const f = fakeFetch({});
    expect(await judgeRelevance({ ...config, baseUrl: "" }, "x", decisions, f.impl)).toEqual({ ids: [], probabilities: {} });
    expect(f.calls).toHaveLength(0);
  });

  it("HTTP の失敗は error を返し、id は空", async () => {
    const f = fakeFetch({}, 503);
    expect(await judgeRelevance(config, "x", decisions, f.impl)).toEqual({ ids: [], probabilities: {}, error: "HTTP 503" });
  });

  it("時間内に答えなければ諦める", async () => {
    const hang = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))) as never;
    const r = await judgeRelevance({ ...config, timeoutMs: 20 }, "x", decisions, hang);
    expect(r.ids).toEqual([]);
    expect(r.error).toBe("20ms で答えなかった");
  });
});

describe("warmUp: 暖機", () => {
  it("ローカルの接続先にだけ、問いを 1 つ投げる", async () => {
    const f = fakeFetch({ warm: { type: "noul", noul: 0.9 } });
    expect(await warmUp({ baseUrl: "http://127.0.0.1:11435", model: "laya:multilingual" }, f.impl)).toBe(true);
    expect(JSON.parse(f.calls[0]!.init.body)).toMatchObject({ model: "laya:multilingual", questions: { warm: { type: "noul" } } });

    const g = fakeFetch({});
    expect(await warmUp({ baseUrl: "https://api.typesafe.ai", model: "jev" }, g.impl)).toBe(false);
    expect(g.calls).toHaveLength(0);
  });

  it("ローカルかどうかはホスト名で見る", () => {
    expect(isLocal("http://localhost:11435")).toBe(true);
    expect(isLocal("https://api.typesafe.ai")).toBe(false);
    expect(isLocal("not a url")).toBe(false);
  });
});
