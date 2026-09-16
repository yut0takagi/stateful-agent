/**
 * ツール実行をチャットに埋め込むための整形。
 *
 * Claude Code for VSCode と同じ形にする — ツール1回につきカードが1枚流れ、
 * 見出し（コマンド or ファイル名）の下に結果や差分がインラインで入る。
 *
 * 差分は canUseTool の入力（これから書く内容）と、書き換え前のファイル内容から自前で作る。
 * 依存は増やさない。行単位の LCS で足りる。
 *
 * VSCode API に依存させない。ファイル読みは呼び出し側が渡す。
 */

export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** カード1枚。Webview はこれを見て描画する。 */
export interface ToolCard {
  kind: "diff" | "command" | "plain";
  /** 見出し。コマンド文字列 or ファイル名。 */
  title: string;
  /** 補助表示（フルパスなど）。 */
  subtitle?: string;
  lines?: DiffLine[];
  added?: number;
  removed?: number;
  truncated?: boolean;
}

/** 差分に載せる最大行数。これを超えたら打ち切る。 */
const MAX_DIFF_LINES = 60;
/** Bash 出力に載せる最大行数。 */
const MAX_OUTPUT_LINES = 30;

/**
 * Bash 出力の表示行数。
 *
 * 先頭だけ出す。コマンドの出力は先頭に「何をしたか」が出るので、
 * 進行を追うにはそれで足りる。全行出すとチャットが実行ログで埋まる。
 */
const BASH_PREVIEW_LINES = 3;

/**
 * 行単位の差分。LCS を取って、共通部分を same、
 * 旧にしかない行を del、新にしかない行を add にする。
 *
 * ファイル全体を O(n*m) で回すので、巨大ファイルでは行数を制限してから呼ぶ。
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
  const b = newText === "" ? [] : newText.replace(/\n$/, "").split("\n");

  // LCS の長さ表
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });

  return out;
}

/**
 * 差分を表示用に間引く。
 *
 * 変更のない行が延々続くと読めないので、変更行の周囲だけ残す
 * （標準的な diff の context と同じ考え方）。
 */
function condense(lines: DiffLine[], context = 2): { lines: DiffLine[]; truncated: boolean } {
  const keep = new Set<number>();
  lines.forEach((l, idx) => {
    if (l.kind !== "same") {
      for (let k = idx - context; k <= idx + context; k++) {
        if (k >= 0 && k < lines.length) keep.add(k);
      }
    }
  });

  // 変更が無いなら先頭だけ見せる
  if (keep.size === 0) {
    return { lines: lines.slice(0, 3), truncated: lines.length > 3 };
  }

  const picked = [...keep].sort((x, y) => x - y).map((idx) => lines[idx]);
  if (picked.length > MAX_DIFF_LINES) {
    return { lines: picked.slice(0, MAX_DIFF_LINES), truncated: true };
  }
  return { lines: picked, truncated: picked.length < lines.length };
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

/**
 * ツール呼び出しをカードにする。
 *
 * @param before 書き換え前のファイル内容。無ければ null（新規 or 読めない）。
 */
export function summarizeToolUse(
  toolName: string,
  input: Record<string, unknown>,
  before: string | null,
): ToolCard {
  const filePath = typeof input.file_path === "string" ? input.file_path : null;

  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return { kind: "command", title: command };
  }

  if ((toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") && filePath) {
    const oldText = before ?? "";
    let newText: string;

    if (toolName === "Write") {
      newText = typeof input.content === "string" ? input.content : "";
    } else {
      // Edit: 旧内容に置換をかけた結果を新内容とみなす
      const oldStr = typeof input.old_string === "string" ? input.old_string : "";
      const newStr = typeof input.new_string === "string" ? input.new_string : "";
      newText = oldStr === "" ? oldText : oldText.split(oldStr).join(newStr);
      // 既存内容が読めなかった場合は、置換片だけで差分を作る
      if (before === null) {
        newText = newStr;
        return finishDiff(filePath, oldStr, newText);
      }
    }

    return finishDiff(filePath, oldText, newText);
  }

  return {
    kind: "plain",
    title: filePath ? basename(filePath) : toolName,
    subtitle: filePath ?? undefined,
  };
}

function finishDiff(filePath: string, oldText: string, newText: string): ToolCard {
  const full = diffLines(oldText, newText);
  const added = full.filter((l) => l.kind === "add").length;
  const removed = full.filter((l) => l.kind === "del").length;
  const { lines, truncated } = condense(full);
  return {
    kind: "diff",
    title: basename(filePath),
    subtitle: filePath,
    lines,
    added,
    removed,
    truncated,
  };
}

/** Bash の出力を表示用に整える。長いものは末尾を残す（結論は末尾にあることが多い）。 */
export function renderBashResult(output: string): {
  lines: string[];
  truncated: boolean;
  /** 表示しなかった行数。何が隠れているか分かるように返す。 */
  omitted: number;
} {
  const body = output.replace(/\n+$/, "");
  if (body === "") {
    return { lines: [], truncated: false, omitted: 0 };
  }

  const all = body.split("\n");
  if (all.length <= BASH_PREVIEW_LINES) {
    return { lines: all, truncated: false, omitted: 0 };
  }
  return {
    lines: all.slice(0, BASH_PREVIEW_LINES),
    truncated: true,
    omitted: all.length - BASH_PREVIEW_LINES,
  };
}
