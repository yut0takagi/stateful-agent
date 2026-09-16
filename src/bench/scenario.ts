/**
 * 対照実験ベンチの中核。
 *
 * モードごとに同じプロンプト列を同じ順序で流し、
 * **ターンを重ねたときの伸び方**を比べる。
 *
 * 単発の質問を各モードで1回ずつ投げても差は出ない（実測済み: in/out/cache
 * いずれもほぼ同値）。履歴を捨てる効果はターンが積み上がって初めて現れるので、
 * 会話が継続するシナリオを何周も回す。
 *
 * VSCode API にも SDK にも依存させない。ここは純粋な計算だけ持つ。
 */

export interface Scenario {
  prompts: string[];
}

/**
 * シナリオファイルを読む。1行1プロンプト。
 *
 * `#` 始まりはコメント。空行は無視。
 * 凝った書式にしないのは、実験条件を人が読んで確かめられるようにするため。
 */
export function parseScenario(raw: string): Scenario {
  const prompts = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  return { prompts };
}

/**
 * n ターン目に投げるプロンプト。末尾まで行ったら先頭に戻る。
 *
 * 巡回させるのは、同じ質問の繰り返しでは会話が進まないため。
 * 一巡すると同じ問いに戻るので、「state が積み上がった状態で同じ問いに
 * 答えるとどうなるか」も観測できる。
 */
export function nextPrompt(scenario: Scenario, turnIndex: number): string | null {
  if (scenario.prompts.length === 0) {
    return null;
  }
  return scenario.prompts[turnIndex % scenario.prompts.length];
}

/** 1ターンの実測値。 */
export interface BenchTurn {
  mode: string;
  /** 何ターン目か（0 始まり）。 */
  index: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  /** 応答が返るまでの実時間（ミリ秒）。体感の重さ。 */
  ms: number;
  statePatched: boolean;
  /** そのターン終了時点の state のサイズ。膨らみ続けないか見る。 */
  stateBytes: number;
  /** そのターンで何をしたか。読んだファイル・実行したコマンドの証跡。 */
  tools?: ToolSummary;
  /** ツール出力を中略して削った文字数。--trim のときだけ入る。 */
  trimmedChars?: number;
  /** 中略したツール呼び出しの件数 / 全件。 */
  trimmedCalls?: number;
}

export interface ModeComparison {
  turns: number;
  totalCostUSD: number;
  avgOut: number;
  avgMs: number;
  /** 1ターンあたり cache_read が何トークン増えるか。これが「重くなる速さ」。 */
  cacheGrowthPerTurn: number;
  firstCacheRead: number;
  lastCacheRead: number;
  lastStateBytes: number;
  patchRate: number;
}

/**
 * モードごとに集計する。
 *
 * 傾き（cacheGrowthPerTurn）が主役。総量ではなく**増え方**を比べたい。
 * 総量は最初に読んだファイルの量に左右され、モードの差を隠してしまう。
 */
export function buildComparison(turns: BenchTurn[]): Record<string, ModeComparison> {
  const byMode = new Map<string, BenchTurn[]>();
  for (const t of turns) {
    const list = byMode.get(t.mode) ?? [];
    list.push(t);
    byMode.set(t.mode, list);
  }

  const out: Record<string, ModeComparison> = {};
  for (const [mode, list] of byMode) {
    // 到着順に依存しないよう index で並べ直す。
    const sorted = [...list].sort((a, b) => a.index - b.index);
    const n = sorted.length;
    const sum = (pick: (t: BenchTurn) => number): number =>
      sorted.reduce((acc, t) => acc + pick(t), 0);

    const first = sorted[0].cacheReadTokens;
    const last = sorted[n - 1].cacheReadTokens;
    const span = n - 1;

    out[mode] = {
      turns: n,
      totalCostUSD: sum((t) => t.costUSD),
      avgOut: Math.round(sum((t) => t.outputTokens) / n),
      avgMs: Math.round(sum((t) => t.ms) / n),
      cacheGrowthPerTurn: span > 0 ? Math.round((last - first) / span) : 0,
      firstCacheRead: first,
      lastCacheRead: last,
      lastStateBytes: sorted[n - 1].stateBytes,
      patchRate: sum((t) => (t.statePatched ? 1 : 0)) / n,
    };
  }
  return out;
}

// ---- セッション内の動きを残す ----

/** 記録するツール呼び出し。 */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolSummary {
  total: number;
  /** ツール名ごとの回数。 */
  counts: Record<string, number>;
  /** 読んだファイル（重複なし）。何を見て答えたかの証跡。 */
  filesRead: string[];
  /** Grep / Glob のパターン。探索の跡。 */
  patterns: string[];
  /** 実行したコマンド（先頭のみ）。 */
  commands: string[];
}

/** Bash コマンドの記録長。全文を残すとログがプロンプトの複製になる。 */
const COMMAND_LIMIT = 60;

/**
 * 1ターンのツール呼び出しをまとめる。
 *
 * 集計値（トークン・時間）だけでは「なぜ重かったか」が説明できない。
 * cache_read が45万に達するのはファイルを読むからで、
 * **どのファイルを何回読んだか**が分かって初めて削減の当てがつく。
 */
export function summarizeTools(calls: ToolCall[]): ToolSummary {
  const counts: Record<string, number> = {};
  const filesRead = new Set<string>();
  const patterns = new Set<string>();
  const commands: string[] = [];

  for (const call of calls) {
    counts[call.name] = (counts[call.name] ?? 0) + 1;

    const file = call.input?.file_path;
    if (typeof file === "string" && file !== "") {
      filesRead.add(file);
    }
    const pattern = call.input?.pattern;
    if (typeof pattern === "string" && pattern !== "") {
      patterns.add(pattern);
    }
    const command = call.input?.command;
    if (typeof command === "string" && command !== "") {
      commands.push(
        command.length > COMMAND_LIMIT ? command.slice(0, COMMAND_LIMIT - 1) + "…" : command,
      );
    }
  }

  return {
    total: calls.length,
    counts,
    filesRead: [...filesRead],
    patterns: [...patterns],
    commands,
  };
}
