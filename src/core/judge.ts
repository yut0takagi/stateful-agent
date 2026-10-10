/**
 * 判断モデルに「この決定は今回の指示に関係するか」を聞く。
 *
 * 相手は TypeSafe の `/v1/systemone` の形で答えるもの。TypeSafe の Jev（要 API キー）と、
 * それと同じ形で答えるローカル実行の Ollaya（Laya などを動かす。既定は http://localhost:11435）を想定する。
 * Noul の質問を決定ごとに 1 つ作り、`answers.<名前>.noul`（0〜1）が閾値以上のものを関係ありとみなす。
 *
 * 本物の Laya（Ollaya 0.12.0、laya:multilingual）で、devtch の決定 20 件を CPU で約 1 秒で判定できた
 * （初回はモデルの読み込みで約 4 秒）。関係の薄い決定も 0.5〜0.8 に入るので、閾値は 0.8 を既定にする。
 *
 * 判断モデルは補助で、なくても動く。呼べない・遅い・形が違うときは空を返し、
 * プロンプトはグラフの規則（ledger.ts の selectDetailed）だけで組む。
 */

import { summarizeDecision } from "./ledger.js";

type Rec = Record<string, unknown>;

export interface JudgeConfig {
  /** 例: http://localhost:11435（Ollaya）、https://api.typesafe.ai（Jev）。空なら呼ばない。 */
  baseUrl: string;
  /** モデルの名前。`/v1/systemone` では必須（実測: 省くと HTTP 422）。Ollaya なら laya など。 */
  model: string;
  /** TypeSafe の API キー。ローカルの Ollaya なら要らない。 */
  apiKey?: string;
  /** これ以上の確率を関係ありとみなす。 */
  threshold: number;
  /** これを過ぎたら諦める。プロンプトを組む前に待つので短くする。 */
  timeoutMs: number;
}

/** 1 回に聞く決定の上限。問いが多いほど遅くなるので、新しいものから選ぶ。 */
export const MAX_CANDIDATES = 40;

export interface JudgeResult {
  /** 関係ありとみなした決定の id。 */
  ids: string[];
  /** 決定の id ごとの確率。見せる用。 */
  probabilities: Record<string, number>;
  /** 呼べなかった理由。呼べたら undefined。 */
  error?: string;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** `/v1/systemone` に送る本文。決定の id は質問の名前に使わず、q0, q1, … に置き換える（名前に使えない文字があるため）。 */
export function buildRequest(model: string, instruction: string, candidates: Rec[]): { body: Rec; names: Map<string, string> } {
  const names = new Map<string, string>();
  const questions: Rec = {};
  candidates.forEach((d, i) => {
    const id = typeof d.id === "string" ? d.id : null;
    if (id === null) {
      return;
    }
    const name = `q${i}`;
    names.set(name, id);
    questions[name] = {
      type: "noul",
      instructions: `次の決定は、この指示に取り組むときに参照すべきか。決定: ${summarizeDecision(d)}`,
      criteria: { true: "指示の内容に直接かかわる", false: "指示とは関係しない" },
    };
  });
  return { body: { model, state: `指示: ${instruction}`, questions }, names };
}

/** 返答から、質問の名前ごとの確率を取り出す。形が違う答えは捨てる。 */
export function parseAnswers(response: unknown): Record<string, number> {
  const answers = (response as { answers?: unknown } | null)?.answers;
  if (typeof answers !== "object" || answers === null) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [name, a] of Object.entries(answers as Rec)) {
    const p = (a as { noul?: unknown } | null)?.noul;
    if (typeof p === "number" && Number.isFinite(p)) {
      out[name] = p;
    }
  }
  return out;
}

export async function judgeRelevance(
  config: JudgeConfig,
  instruction: string,
  candidates: Rec[],
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<JudgeResult> {
  const picked = candidates.filter((d) => typeof d.id === "string").slice(-MAX_CANDIDATES);
  if (config.baseUrl.trim() === "" || picked.length === 0) {
    return { ids: [], probabilities: {} };
  }
  const { body, names } = buildRequest(config.model, instruction, picked);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ids: [], probabilities: {}, error: `HTTP ${res.status}` };
    }
    const probabilities: Record<string, number> = {};
    const ids: string[] = [];
    for (const [name, p] of Object.entries(parseAnswers(await res.json()))) {
      const id = names.get(name);
      if (id === undefined) {
        continue;
      }
      probabilities[id] = p;
      if (p >= config.threshold) {
        ids.push(id);
      }
    }
    return { ids, probabilities };
  } catch (e) {
    return { ids: [], probabilities: {}, error: controller.signal.aborted ? `${config.timeoutMs}ms で答えなかった` : e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * モデルを読み込ませておく（暖機）。結果は捨てる。
 *
 * Ollaya は使わないモデルを約 5 分で下ろし、読み込み直しに約 4 秒かかる（実測）。
 * それだとターンの前の待ち時間（timeoutMs）を超え、毎回規則だけになる。
 * 人が入力欄に打ち始めたときに呼べば、送るまでに読み込みが済む。
 * 有料の API に余計な問いを投げないよう、ローカルの接続先だけを暖める。
 */
export async function warmUp(
  config: Pick<JudgeConfig, "baseUrl" | "model">,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 15_000,
): Promise<boolean> {
  if (!isLocal(config.baseUrl)) {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        state: "暖機",
        questions: { warm: { type: "noul", instructions: "これは暖機のための問いか", criteria: { true: "はい", false: "いいえ" } } },
      }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** ローカルの接続先か。暖機はここにだけ投げる。 */
export function isLocal(baseUrl: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}
