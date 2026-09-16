/**
 * ツール出力の予算管理 — ラリー内で context に入る量を削る層。
 *
 * これまで削減の的は「会話履歴」だった。実測でそれが外れていると分かった。
 *
 * | 項目 | stateless | recent | full |
 * |---|---|---|---|
 * | inputTokens がコストに占める割合 | 0.0% | 0.0% | 0.0% |
 * | cacheCreation | 45.9% | 46.5% | 23.2% |
 * | out | 26.0% | 28.8% | 38.6% |
 *
 * 履歴を切る操作は inputTokens にしか効かない。そこが 0.0% なので、
 * 履歴モードを変えても総額は動かなかった（実測: stateless $1.025 >
 * recent $0.886 > full $0.613 と、履歴を**持つ**ほうが安い）。
 *
 * 動いているのはラリー内部のツール出力。Read / Bash / Grep の結果は
 * エージェントループの各ステップで prefix に積まれ、次の推論で読み直される。
 * だから削る対象はツール出力であって、対話ログではない。
 *
 * SDK の PostToolUse フックは `updatedToolOutput` を持つ
 * （「Replaces the tool output before it is sent to the model」）。
 * モデルに届く前に差し替えられるので、ここで予算をかける。
 *
 * この層は SDK にも VSCode にも fs にも依存しない。純粋な文字列処理として置く。
 */

/** ツール種別ごとの上限（文字数）。 */
export interface BudgetLimits {
  /** ファイル読み取り系の1回あたり上限。 */
  read: number;
  /** コマンド実行系の1回あたり上限。 */
  bash: number;
  /** 検索系の1回あたり上限。 */
  search: number;
  /** 上表に当たらないツールの上限。 */
  other: number;
  /** 1ターンで全ツール合計の上限。超えた分は以降を強く削る。 */
  turnTotal: number;
}

/**
 * 既定値。
 *
 * 根拠: 実測のツール出力は Read で 2,000〜8,000 文字、Bash で数百〜数万文字。
 * read を 4,000 にすると「ファイルのどこに何があるか」は残り、全文は落ちる。
 * これは推測混じりの初期値なので、bench で測って動かす前提で置く
 * （README の未決に「上限値の実測」として残す）。
 */
export const DEFAULT_LIMITS: BudgetLimits = {
  read: 4000,
  bash: 3000,
  search: 2000,
  other: 3000,
  turnTotal: 40000,
};

/** ツール名から予算の種別を決める。 */
export function categoryOf(toolName: string): keyof Omit<BudgetLimits, "turnTotal"> {
  if (toolName === "Read" || toolName === "NotebookRead") {
    return "read";
  }
  if (toolName === "Bash" || toolName === "BashOutput") {
    return "bash";
  }
  if (toolName === "Grep" || toolName === "Glob") {
    return "search";
  }
  return "other";
}

/**
 * ツール結果を文字列に寄せる。
 *
 * tool_response は文字列にも、content 配列にも、オブジェクトにもなる。
 * 差し替えるには一度文字列にする必要がある。
 * 構造が読めないものは null を返し、呼び出し側は「触らない」を選ぶ
 * （読めない構造を推測で壊すと、ツールが動かなくなるほうが高い代償になる）。
 */
export function toText(response: unknown): string | null {
  if (typeof response === "string") {
    return response;
  }
  if (Array.isArray(response)) {
    const parts = response.map((c) => {
      const b = c as { type?: string; text?: string };
      return b.type === "text" && typeof b.text === "string" ? b.text : "";
    });
    // 1つもテキストが取れないなら画像等。触らない。
    return parts.some((p) => p !== "") ? parts.filter((p) => p !== "").join("\n") : null;
  }
  if (typeof response === "object" && response !== null) {
    const o = response as { content?: unknown; stdout?: unknown };
    if (typeof o.stdout === "string") {
      return o.stdout;
    }
    if (o.content !== undefined) {
      return toText(o.content);
    }
  }
  return null;
}

export interface TrimResult {
  text: string;
  /** 削ったか。false なら元のまま。 */
  trimmed: boolean;
  originalChars: number;
  keptChars: number;
}

/**
 * 頭と尾を残して真ん中を落とす。
 *
 * 先頭だけ残す方式にしない理由: ファイルは末尾に export や結論が来ることが多く、
 * コマンド出力は末尾にエラーと終了状態が来る。末尾を捨てると
 * 「で、結果どうなったのか」が読めなくなり、モデルが同じツールを打ち直す。
 * 打ち直しは削減した分を上回って context を食うので、頭と尾の両方を残す。
 *
 * 行境界で切る。行の途中で切ると壊れた JSON やコードが混ざり、
 * モデルがそれを実在の構文として読んでしまう。
 */
export function trimMiddle(text: string, limit: number): TrimResult {
  const original = text.length;
  if (original <= limit) {
    return { text, trimmed: false, originalChars: original, keptChars: original };
  }

  // 頭を厚めに取る（何のファイル/何のコマンドかは冒頭で決まる）。
  const headBudget = Math.floor(limit * 0.6);
  const tailBudget = limit - headBudget;

  const lines = text.split("\n");

  const head: string[] = [];
  let headLen = 0;
  for (const line of lines) {
    if (headLen + line.length + 1 > headBudget) {
      break;
    }
    head.push(line);
    headLen += line.length + 1;
  }

  const tail: string[] = [];
  let tailLen = 0;
  for (let i = lines.length - 1; i >= head.length; i -= 1) {
    const line = lines[i];
    if (tailLen + line.length + 1 > tailBudget) {
      break;
    }
    tail.unshift(line);
    tailLen += line.length + 1;
  }

  const droppedLines = lines.length - head.length - tail.length;
  const droppedChars = original - headLen - tailLen;

  // 何がどれだけ落ちたかを明示する。黙って切ると、モデルは
  // 「ファイルはここで終わっている」と誤読して結論を出す。
  const notice =
    `\n… [stateful-agent: ${droppedLines} 行 / 約 ${droppedChars} 文字を中略。` +
    `全体は ${lines.length} 行。必要なら範囲を絞って読み直すこと（例: Read の offset/limit、` +
    `Bash なら grep や sed -n で該当箇所だけ）] …\n`;

  return {
    text: head.join("\n") + notice + tail.join("\n"),
    trimmed: true,
    originalChars: original,
    keptChars: headLen + tailLen,
  };
}

/** 1ターン分の予算を追跡する。ターンごとに作り直す。 */
export class TurnBudget {
  private spent = 0;
  private readonly records: BudgetRecord[] = [];

  constructor(private readonly limits: BudgetLimits = DEFAULT_LIMITS) {}

  /**
   * ツール出力に予算をかける。差し替えが要らなければ null を返す
   * （null のときフック側は updatedToolOutput を付けない = 元の出力がそのまま行く）。
   */
  apply(toolName: string, response: unknown): string | null {
    const text = toText(response);
    if (text === null) {
      // 構造が読めないものは触らない。壊すリスクのほうが高い。
      return null;
    }

    const category = categoryOf(toolName);
    let limit = this.limits[category];

    // ターン合計を超えたら、以降は種別上限をさらに絞る。
    // 1回あたりの上限だけだと、小さい出力を何十回も積んで総量が膨らむ経路が残る。
    if (this.spent >= this.limits.turnTotal) {
      limit = Math.min(limit, 800);
    }

    const result = trimMiddle(text, limit);
    this.spent += result.keptChars;
    this.records.push({
      tool: toolName,
      originalChars: result.originalChars,
      keptChars: result.keptChars,
      trimmed: result.trimmed,
    });

    return result.trimmed ? result.text : null;
  }

  /** このターンで何をどれだけ削ったか。UI に出して人が効き目を見る。 */
  report(): BudgetReport {
    const savedChars = this.records.reduce(
      (sum, r) => sum + (r.originalChars - r.keptChars),
      0,
    );
    return {
      calls: this.records.length,
      trimmedCalls: this.records.filter((r) => r.trimmed).length,
      totalOriginalChars: this.records.reduce((s, r) => s + r.originalChars, 0),
      totalKeptChars: this.spent,
      savedChars,
      records: [...this.records],
    };
  }
}

export interface BudgetRecord {
  tool: string;
  originalChars: number;
  keptChars: number;
  trimmed: boolean;
}

export interface BudgetReport {
  calls: number;
  trimmedCalls: number;
  totalOriginalChars: number;
  totalKeptChars: number;
  savedChars: number;
  records: BudgetRecord[];
}
