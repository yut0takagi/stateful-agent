/**
 * ターンごとの実測ログ。
 *
 * 設計 spec が P1 の完了条件に挙げている「モードごとに modelUsage と
 * rate_limit_event を記録し、論文の削減率が vault の使い方で再現するかを実測する」の実体。
 *
 * これが無いと「stateless にすると本当に安いのか」に数字で答えられない。
 * 抽出エージェントを分離する判断（トークンが増える取引が割に合うか）も
 * ここのデータが無いと決められないので、先に入れる。
 *
 * VSCode API に依存させない。ファイル追記は呼び出し側がやる。
 */

import type { HistoryMode } from "./state.js";

/** ログ1行。jsonl として .ctx/state/runs.jsonl に積む。 */
export interface RunRecord {
  at: string;
  mode: HistoryMode;
  /** 指示の先頭だけ。何のターンだったか思い出せれば足りる。 */
  instruction: string;
  in: number;
  out: number;
  /** キャッシュから読めたトークン。0 が続くならキャッシュが引き継がれていない。 */
  cache_read: number;
  /** キャッシュに書いたトークン。書くだけで読めていないなら無駄になっている。 */
  cache_create: number;
  /** state パッチが返ってきたか。無音の据え置きを検出するために持つ。 */
  patched: boolean;
  costUSD?: number;
  rate_limit?: unknown;
}

export interface BuildRunRecordInput {
  mode: HistoryMode;
  instruction: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUSD?: number;
  };
  statePatched: boolean;
  rateLimit?: unknown;
  now: Date;
}

const INSTRUCTION_LIMIT = 80;

/**
 * ログ1行を組み立てる。
 *
 * 指示は先頭 80 字だけ残す。プロンプト全文を残すとログがプロンプトの複製になり、
 * 「履歴を持たない」と言いながら別の場所に履歴を作ることになる。
 */
export function buildRunRecord(input: BuildRunRecordInput): RunRecord {
  const instruction = input.instruction.replace(/\s+/g, " ").trim();
  const record: RunRecord = {
    at: input.now.toISOString(),
    mode: input.mode,
    instruction:
      instruction.length > INSTRUCTION_LIMIT
        ? instruction.slice(0, INSTRUCTION_LIMIT - 1) + "…"
        : instruction,
    // usage が取れなかったターンも 0 で残す。落ちたことを記録しないと分母がずれる。
    in: input.usage?.inputTokens ?? 0,
    out: input.usage?.outputTokens ?? 0,
    cache_read: input.usage?.cacheReadTokens ?? 0,
    cache_create: input.usage?.cacheCreationTokens ?? 0,
    patched: input.statePatched,
  };
  if (input.usage?.costUSD !== undefined) {
    record.costUSD = input.usage.costUSD;
  }
  if (input.rateLimit !== undefined) {
    record.rate_limit = input.rateLimit;
  }
  return record;
}

/** jsonl の1行にする。 */
export function formatRunLine(record: RunRecord): string {
  return JSON.stringify(record) + "\n";
}

export interface ModeSummary {
  turns: number;
  avgIn: number;
  avgOut: number;
  /** state パッチが返った割合。自己申告型の取りこぼしを見る。 */
  patchRate: number;
  /** キャッシュから読めたトークンの平均。 */
  avgCacheRead: number;
  /**
   * 入力のうちキャッシュから読めた割合。
   *
   * これが 0 に張り付いていたら、キャッシュが引き継がれていない
   * （resume を渡さないモードはセッションが毎ターン新しくなる）。
   */
  cacheHitRate: number;
  /** 最初のターンの cache_read。 */
  firstCacheRead: number;
  /** 最後のターンの cache_read。 */
  lastCacheRead: number;
  /**
   * 1ターンあたり cache_read が何トークン増えたか。
   *
   * キャッシュが効いていても、読む対象が膨らめばコストと時間はかかる。
   * ヒット率だけ見ていると「効いているのに重い」を見逃す。
   */
  growthPerTurn: number;
}

/** モードごとに集計する。削減率を見るための最小限。 */
export function summarize(rows: RunRecord[]): Record<string, ModeSummary> {
  const byMode = new Map<string, RunRecord[]>();
  for (const row of rows) {
    const list = byMode.get(row.mode) ?? [];
    list.push(row);
    byMode.set(row.mode, list);
  }

  const out: Record<string, ModeSummary> = {};
  for (const [mode, list] of byMode) {
    const sum = (pick: (r: RunRecord) => number): number =>
      list.reduce((acc, r) => acc + pick(r), 0);
    out[mode] = {
      turns: list.length,
      avgIn: Math.round(sum((r) => r.in) / list.length),
      avgOut: Math.round(sum((r) => r.out) / list.length),
      patchRate: sum((r) => (r.patched ? 1 : 0)) / list.length,
      avgCacheRead: Math.round(sum((r) => r.cache_read ?? 0) / list.length),
      // 分母は「キャッシュ込みの入力全体」。in はキャッシュを除いた分なので足す。
      cacheHitRate: hitRate(sum((r) => r.cache_read ?? 0), sum((r) => r.in)),
      ...growth(list),
    };
  }
  return out;
}

/**
 * cache_read の推移を出す。
 *
 * ログの並び順は保証しないので、時刻で並べ直してから先頭と末尾を取る。
 */
function growth(list: RunRecord[]): {
  firstCacheRead: number;
  lastCacheRead: number;
  growthPerTurn: number;
} {
  // at が欠けた行（古いログ・壊れた行）でも落とさない。
  const sorted = [...list].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  const first = sorted[0]?.cache_read ?? 0;
  const last = sorted[sorted.length - 1]?.cache_read ?? 0;
  // 2ターン未満では増加を語れない。
  const span = sorted.length - 1;
  return {
    firstCacheRead: first,
    lastCacheRead: last,
    growthPerTurn: span > 0 ? Math.round((last - first) / span) : 0,
  };
}

/** キャッシュ読み込み / 入力全体。入力ゼロのときは 0（0除算を作らない）。 */
function hitRate(cacheRead: number, freshInput: number): number {
  const total = cacheRead + freshInput;
  return total === 0 ? 0 : cacheRead / total;
}

/** jsonl を読んで RunRecord にする。壊れた行は捨てる。 */
export function parseRunLog(raw: string): RunRecord[] {
  const out: RunRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    // 1行に複数レコードが連結していることがある（実測: 同時書き込みで
    // 改行が落ち、1ターンぶんの計測が丸ごと集計から消えた）。
    out.push(...parseConcatenated(line));
  }
  return out;
}

/**
 * 1行から JSON オブジェクトを取れるだけ取る。
 *
 * 通常は1行1レコードだが、`}{` で連結している場合に両方拾う。
 * 復元できない断片は捨てる（壊れた1行で集計全体を落とさない）。
 */
function parseConcatenated(line: string): RunRecord[] {
  const found: RunRecord[] = [];
  let rest = line.trim();

  while (rest !== "") {
    const end = endOfFirstObject(rest);
    if (end === -1) {
      break;
    }
    try {
      const parsed = JSON.parse(rest.slice(0, end));
      if (typeof parsed === "object" && parsed !== null && typeof parsed.mode === "string") {
        found.push(parsed as RunRecord);
      }
    } catch {
      // この断片は諦めて次へ
    }
    rest = rest.slice(end).trim();
  }
  return found;
}

/**
 * 先頭の JSON オブジェクトが終わる位置を返す。見つからなければ -1。
 *
 * 波括弧を数えるだけだと文字列中の `}` に引っかかるので、
 * クォートとエスケープを見ながら進む。
 */
function endOfFirstObject(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}
