/**
 * 読み方の誘導 — 入る前に減らす層。
 *
 * パターンA（toolbudget）が「出てきた出力を削る」のに対し、こちらは
 * **そもそも大きく読ませない**。介入点が違う。
 *
 * | | 介入点 | 何をする | 弱点 |
 * |---|---|---|---|
 * | A: 出力予算 | `PostToolUse` | 返ってきた出力を中略 | 一度読んだ分の時間は消費済み。中略を見てモデルが読み直すと二重になる |
 * | B: 読み方誘導 | `canUseTool` | 入力を書き換えて範囲読みにする | 全文が本当に必要なときに邪魔になりうる |
 *
 * 実測の根拠は同じ: inputTokens はコストの 0.0% で、動いているのは
 * ラリー内部のツール出力（cacheCreate 45.9% / cacheRead 28.2%）。
 * ただし A は「読んでから捨てる」ので、ファイル取得自体のコスト
 * （ディスク読み・ツール往復）は払っている。B はそれも払わない。
 *
 * この層は SDK にも VSCode にも依存しない。判断だけを持つ。
 */

/** ファイルの行数と、読み方の判断に要る情報。 */
export interface FileFacts {
  /** 総行数。数えられなければ null。 */
  lines: number | null;
  /** バイト数。数えられなければ null。 */
  bytes: number | null;
}

export interface ReadPlanLimits
{
  /** これを超える行数のファイルは範囲読みに落とす。 */
  maxLines: number;
  /** 範囲読みに落とすときの1回あたり行数。 */
  windowLines: number;
  /** これを超えるバイト数なら行数に関わらず範囲読みにする。 */
  maxBytes: number;
}

/**
 * 既定値。
 *
 * 根拠: 実測の Read 出力は 2,000〜8,000 文字が主。800行あたりで
 * 「構造を掴む」用途には十分、かつ全文読みの半分以下に収まる。
 * 仮置きなので bench で動かす前提（README の未決に残す）。
 */
export const DEFAULT_READ_LIMITS: ReadPlanLimits = {
  maxLines: 800,
  windowLines: 400,
  maxBytes: 60_000,
};

export type ReadDecision =
  | { kind: "allow" }
  | {
      kind: "narrow";
      /** 書き換えた入力。Read の offset/limit を足したもの。 */
      updatedInput: Record<string, unknown>;
      /** なぜ絞ったか。UI とモデルに見せる。 */
      reason: string;
    };

/**
 * Read の入力に範囲を足すか決める。
 *
 * モデルが自分で offset/limit を書いているなら触らない — 意図を持って
 * 範囲を決めているものを上書きすると、同じ範囲を読み直す往復が増える。
 *
 * 行数が分からないファイル（読めない・存在しない）も触らない。
 * 推測で範囲を付けると、短いファイルの後半を理由なく隠すことになる。
 */
export function planRead(
  input: Record<string, unknown>,
  facts: FileFacts,
  limits: ReadPlanLimits = DEFAULT_READ_LIMITS,
): ReadDecision {
  // モデルが既に範囲を指定している → 尊重する
  if (input.offset !== undefined || input.limit !== undefined) {
    return { kind: "allow" };
  }

  const tooManyLines = facts.lines !== null && facts.lines > limits.maxLines;
  const tooManyBytes = facts.bytes !== null && facts.bytes > limits.maxBytes;

  if (!tooManyLines && !tooManyBytes) {
    return { kind: "allow" };
  }

  const total = facts.lines;
  const reason =
    total !== null
      ? `${total} 行のファイルなので先頭 ${limits.windowLines} 行に絞った。` +
        `続きは offset を指定して読むこと（例: offset=${limits.windowLines + 1}）`
      : `大きいファイル（約 ${facts.bytes} バイト）なので先頭 ${limits.windowLines} 行に絞った。` +
        `続きは offset を指定して読むこと`;

  return {
    kind: "narrow",
    updatedInput: { ...input, offset: 1, limit: limits.windowLines },
    reason,
  };
}

/**
 * Bash の command に出力量の制限を足すか決める。
 *
 * `cat` で巨大ファイルを流す、`find /` で全走査する、といった
 * 「出力が予測できないコマンド」に `head` を足す。
 *
 * 既に出力を絞る意図が見えるコマンド（head/tail/wc/grep -c、
 * リダイレクト、パイプの先で絞っている）は触らない。
 * 二重に絞ると、モデルが期待した行数が返らず原因不明の欠落になる。
 */
export function planBash(
  command: string,
  maxLines = 200,
): { kind: "allow" } | { kind: "narrow"; command: string; reason: string } {
  const trimmed = command.trim();

  // 既に絞っている・書き込み系・対話系は触らない
  if (
    /\|\s*(head|tail|wc|sort\s+-u|uniq|jq)\b/.test(trimmed) ||
    /\b(head|tail|wc)\b/.test(trimmed) ||
    />|>>/.test(trimmed) ||
    /\b(git\s+commit|npm\s+install|rm|mv|cp)\b/.test(trimmed)
  ) {
    return { kind: "allow" };
  }

  // 出力が膨らみやすいコマンドだけを対象にする。
  // 何にでも head を足すと、短い出力の終了状態まで切ってしまう。
  const unbounded = /^\s*(cat|find|ls\s+-R|tree|grep\s+-r|rg)\b/.test(trimmed);
  if (!unbounded) {
    return { kind: "allow" };
  }

  return {
    kind: "narrow",
    command: `{ ${trimmed}; } | head -${maxLines}`,
    reason: `出力が大きくなりうるコマンドなので先頭 ${maxLines} 行に制限した。` +
      `全量が必要なら範囲やパターンを絞って打ち直すこと`,
  };
}
