/**
 * 構造化 state の読み書きと整形。
 *
 * SKILL.state (arXiv:2608.26263) の「①state を持つ」部分。
 * 論文が前提にした固定スキーマは採らない — 実運用では事前にスキーマが決まらないため、
 * キーを追加できる緩いスキーマにする。空のキーは整形時に落とすので、
 * 使わない項目があってもトークンを食わない。
 *
 * VSCode API に依存させない（テスト可能にするため）。ファイル I/O は呼び出し側が渡す。
 */

/** 制御用のキー。プロンプトには載せない。 */
const CONTROL_KEYS = new Set(["schema_version", "active", "history_mode"]);

export type HistoryMode = "stateless" | "recent" | "full";

export interface AgentState {
  schema_version: number;
  active: boolean;
  history_mode?: HistoryMode;
  [key: string]: unknown;
}

export const INITIAL_STATE: AgentState = {
  schema_version: 1,
  active: false,
};

/** 値が「空」か。空の項目はプロンプトに載せない。 */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "" || value === false) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") {
    return Object.keys(value as object).length === 0;
  }
  return false;
}

/**
 * JSON をパースして state にする。壊れていれば初期状態を返す。
 *
 * 壊れた state で作業が止まるより、空から始めるほうがまし。
 */
export function parseState(raw: string): AgentState {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...INITIAL_STATE };
    }
    return { schema_version: 1, active: false, ...parsed };
  } catch {
    return { ...INITIAL_STATE };
  }
}

export function serializeState(state: AgentState): string {
  return JSON.stringify(state, null, 2) + "\n";
}

/**
 * JSON パッチを state に適用する。論文の `Σt+1 = Σt ⊕ ΔΣt`。
 *
 * null を渡したキーは削除される（論文と同じ規約）。
 * ネストしたオブジェクトはマージではなく置換 — 部分更新の曖昧さを避ける。
 */
export function applyPatch(state: AgentState, patch: Record<string, unknown>): AgentState {
  const next: AgentState = { ...state };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
      continue;
    }

    // 「決定+」「決定~」のような配列の部分更新。
    // 毎ターン配列を丸ごと書き直すと out が1万トークンを超えるため
    // （実測: out 12,799 / state 5,404 バイト）、変わった分だけ出せるようにする。
    const op = parseArrayOp(key);
    if (op !== null && Array.isArray(value)) {
      next[op.key] = mergeArray(next[op.key], value, op.mode);
      continue;
    }

    next[key] = value;
  }
  return next;
}

/** 配列操作のサフィックス。+ は追記、~ は id 一致の置換。 */
function parseArrayOp(key: string): { key: string; mode: "append" | "update" } | null {
  if (key.endsWith("+")) {
    return { key: key.slice(0, -1), mode: "append" };
  }
  if (key.endsWith("~")) {
    return { key: key.slice(0, -1), mode: "update" };
  }
  return null;
}

/**
 * 配列に要素を足す / 差し替える。
 *
 * update で id が見つからないときは追記する。取りこぼすより残すほうがよい
 * （モデルが id を書き間違えても、書いた内容自体は失われない）。
 */
function mergeArray(
  current: unknown,
  incoming: unknown[],
  mode: "append" | "update",
): unknown[] {
  // 壊れた state から復帰できるよう、配列でなければ作り直す。
  const base = Array.isArray(current) ? [...current] : [];

  for (const item of incoming) {
    const id = idOf(item);
    const at = mode === "update" && id !== null ? base.findIndex((x) => idOf(x) === id) : -1;
    if (at >= 0) {
      base[at] = item;
      continue;
    }
    // 追記で id が衝突したら振り直す。履歴を持たないモデルは
    // セッションが変わると D1 から採番し直すので、実際に重複が起きる
    // （実測: D6 と D7 が別内容で2件ずつ存在した）。
    base.push(id !== null && hasId(base, id) ? withUniqueId(item, base, id) : item);
  }
  return base;
}

function hasId(list: unknown[], id: string): boolean {
  return list.some((x) => idOf(x) === id);
}

/**
 * 衝突しない id を振り直す。
 *
 * 拒否せず受け入れるのは、拒否すると書かれた内容ごと失われるため。
 * 元の id が読み取れる形（D6-2）にして、由来を追えるようにする。
 */
function withUniqueId(
  item: unknown,
  list: unknown[],
  original: string,
): Record<string, unknown> {
  let n = 2;
  while (hasId(list, `${original}-${n}`)) {
    n += 1;
  }
  return { ...(item as Record<string, unknown>), id: `${original}-${n}` };
}

/** 要素の id。持たないものは null（照合できないので追記になる）。 */
function idOf(item: unknown): string | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const id = (item as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

/**
 * 応答テキストから state パッチを取り出す。
 *
 * モデルには ```state ... ``` のフェンスで返させる。
 * 見つからなければ null（パッチなし = state 据え置き）。
 */
export function extractPatch(responseText: string): Record<string, unknown> | null {
  const match = responseText.match(/```state\s*\n([\s\S]*?)```/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** state を Markdown に整形する。空の項目と制御キーは落とす。 */
export function renderState(state: AgentState): string | null {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(state)) {
    if (CONTROL_KEYS.has(key) || isEmpty(value)) {
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`- **${key}**:`);
      for (const item of value) {
        lines.push(`    - ${String(item)}`);
      }
    } else if (typeof value === "object") {
      lines.push(`- **${key}**:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`    - ${k}: ${String(v)}`);
      }
    } else {
      lines.push(`- **${key}**: ${String(value)}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * モデルに送るプロンプトを組み立てる。
 *
 * stateless: state + 今回の指示のみ（履歴ゼロ）
 * recent:    state + 直近 N ターン + 今回の指示
 * full:      履歴は SDK の resume に任せるので、ここでは指示だけ返す
 */
export function buildPrompt(
  state: AgentState,
  instruction: string,
  recentTurns: string[] = [],
): string {
  const sections: string[] = [];

  const rendered = renderState(state);
  if (rendered) {
    sections.push(
      [
        "## 現在の作業 state",
        "",
        "これが正。過去のやり取りを遡るのではなく、ここを見る。",
        "",
        rendered,
      ].join("\n"),
    );
  }

  if (recentTurns.length > 0) {
    sections.push(["## 直近のやり取り", "", ...recentTurns].join("\n"));
  }

  sections.push(["## 指示", "", instruction].join("\n"));

  // 詳細な規約はシステムプロンプト（STATE_PROTOCOL）にある。
  // ここは毎ターンの念押しなので、形式だけを短く再掲して食い違わせない。
  sections.push(
    [
      "## state の更新",
      "",
      "応答の最後にパッチを出す。引き継ぎ書として書くこと（規約はシステム側に記載）。",
      "",
      "```state",
      '{ "決定": [{ "何を": "...", "前提": ["..."], "行動": "...", "状態": "確定" }] }',
      "```",
    ].join("\n"),
  );

  return sections.join("\n\n");
}

// ---- state インスペクタ（手編集）----

/**
 * 手編集用の JSON にする。制御キーは外す。
 *
 * schema_version / active / history_mode は拡張が管理するもので、
 * 人が触る意味がない。見せると「消していいのか」を毎回考えさせることになる。
 */
export function toEditable(state: AgentState): string {
  const visible: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!CONTROL_KEYS.has(key)) {
      visible[key] = value;
    }
  }
  return JSON.stringify(visible, null, 2) + "\n";
}

export type EditResult =
  | { ok: true; state: AgentState }
  | { ok: false; message: string };

/**
 * 手編集の結果を state に反映する。
 *
 * applyPatch と違い**全置換**する。インスペクタは state 全体を映しているので、
 * 消した行は消えてほしい（パッチ扱いだと削除が表現できない）。
 *
 * 壊れた JSON は拒否する。parseState は「壊れていたら初期状態」に落とすが、
 * それは起動時の話。手編集でそれをやると、打ち間違いで state が消える。
 */
export function applyEdit(state: AgentState, raw: string): EditResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "JSON として読めない" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: "オブジェクトを書くこと（配列や値は不可）" };
  }

  // 制御キーは現在の値を残す。編集側に書かれていても無視する。
  const next: AgentState = {
    schema_version: state.schema_version,
    active: state.active,
    ...(state.history_mode ? { history_mode: state.history_mode } : {}),
  };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!CONTROL_KEYS.has(key)) {
      next[key] = value;
    }
  }
  return { ok: true, state: next };
}

// ---- 台帳型 state の検証 ----

/**
 * 決定レコードの状態語彙。
 *
 * 「確定」と「暫定」を分けるのは、引き継がれた側が再検討していい決定かを
 * 判断できるようにするため。全部「確定」だと何も覆せなくなる。
 */
export const DECISION_STATES = ["確定", "暫定", "撤回"] as const;

/** 決定1件が持つべきフィールド。 */
const DECISION_REQUIRED = ["何を", "行動"] as const;

/** 決定の理由を示すフィールド。どちらか1つは要る。 */
const DECISION_REASON = ["前提", "却下"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 全置換・追記・更新のいずれで書かれていても、その配列の中身を集める。
 *
 * 返り値: 配列（中身あり） / "deleted"（null で削除指示） / null（そのキーが無い）
 */
function collectEntries(
  patch: Record<string, unknown>,
  baseKey: string,
): unknown[] | "deleted" | null {
  const keys = [baseKey, `${baseKey}+`, `${baseKey}~`];
  const present = keys.filter((k) => k in patch);
  if (present.length === 0) {
    return null;
  }
  if (present.every((k) => patch[k] === null)) {
    return "deleted";
  }

  const collected: unknown[] = [];
  for (const key of present) {
    const value = patch[key];
    if (Array.isArray(value)) {
      collected.push(...value);
    } else if (value !== null) {
      // 配列でないものが来たら、呼び出し側に「配列にすること」と言わせる。
      return value as unknown[];
    }
  }
  return collected;
}

/**
 * state パッチが引き継ぎ書として成立しているかを検証し、警告を返す。
 *
 * **保存は止めない。** 警告を出して人に見せるだけに留める。
 * 拒否にすると、モデルが形式を外した瞬間に state が一切更新されなくなり、
 * 「質が低い」より悪い「何も残らない」に転ぶ。
 *
 * 見ているのは「次のターンの自分が読んで作業を再開できるか」。
 * やったことの羅列は、なぜその方針なのかを再検討できないので警告する。
 */
export function validatePatch(patch: Record<string, unknown>): string[] {
  const warnings: string[] = [];

  // 部分更新（決定+ / 決定~）も決定として見る。
  // ここを見落とすと「決定がない」と誤警告して、正しい書き方を咎めることになる。
  const decisions = collectEntries(patch, "決定");

  // 削除の意思表示だけなら中身を問わない。
  if (decisions === "deleted") {
    return [];
  }

  if (decisions === null) {
    // 何かを書いたのに決定が無い = 作業日誌になっている。
    const wroteSomething = Object.keys(patch).some((k) => patch[k] !== null);
    if (wroteSomething) {
      warnings.push(
        "「決定」がない。何をしたかではなく、何をどういう前提で決めたかを残すこと",
      );
    }
    return warnings;
  }

  if (!Array.isArray(decisions)) {
    warnings.push("「決定」は配列にすること（決定1件 = 1レコード）");
    return warnings;
  }

  decisions.forEach((d, i) => {
    const label = `決定[${i}]`;
    if (!isRecord(d)) {
      warnings.push(`${label}: オブジェクトにすること`);
      return;
    }
    for (const key of DECISION_REQUIRED) {
      if (isEmpty(d[key])) {
        warnings.push(`${label}: 「${key}」がない`);
      }
    }
    if (DECISION_REASON.every((key) => isEmpty(d[key]))) {
      warnings.push(
        `${label}: 「前提」か「却下」のどちらかを書くこと（理由がないと引き継いだ側が再検討できない）`,
      );
    }
    const st = d["状態"];
    if (st !== undefined && !DECISION_STATES.includes(st as (typeof DECISION_STATES)[number])) {
      warnings.push(`${label}: 「状態」は ${DECISION_STATES.join(" / ")} のいずれか`);
    }
  });

  const open = collectEntries(patch, "未決");
  if (Array.isArray(open)) {
    open.forEach((o, i) => {
      if (isRecord(o) && isEmpty(o["論点"])) {
        warnings.push(`未決[${i}]: 「論点」がない（何が決まっていないのかを書くこと）`);
      }
    });
  }

  return warnings;
}

// ---- 表示から state フェンスを隠す ----

/** state フェンスの開始マーカー。 */
const FENCE_OPEN = "```state";

/**
 * 完成した応答から state フェンスを除く。
 *
 * パッチは機械が読むものなので、人が読む本文には出さない。
 * 抽出は extractPatch が済ませているので、ここは表示のためだけの処理。
 */
export function stripStateFence(responseText: string): string {
  return responseText.replace(/\n*```state\s*\n[\s\S]*?```\n*/g, "\n").trim();
}

/**
 * ストリーミング中に state フェンス以降を出さないフィルタ。
 *
 * チャンク単位で届くので、フェンスの開始を見つけたら以降を捨てる。
 * state は応答の**最後**に出す規約なので、一度閉じたら後は通さない。
 *
 * バッククォートが1文字ずつ分割されて届くことがあるため、
 * マーカーを跨ぐ可能性のある末尾は保留して次のチャンクと繋げて判定する。
 */
export class StreamFilter {
  /** マーカーの途中かもしれない保留分。 */
  private pending = "";
  /** フェンスに入ったか。入ったら以降は何も通さない。 */
  private suppressed = false;

  /** チャンクを渡し、表示していい分を受け取る。 */
  push(chunk: string): string {
    if (this.suppressed) {
      return "";
    }

    const buffer = this.pending + chunk;
    const at = buffer.indexOf(FENCE_OPEN);
    if (at !== -1) {
      this.suppressed = true;
      this.pending = "";
      return buffer.slice(0, at);
    }

    // マーカーの前方一致で終わっているなら、続きが来るまで判断を保留する。
    // 例: "…本文```" の時点で state か ts か決まらない。
    const hold = longestPrefixAtEnd(buffer, FENCE_OPEN);
    this.pending = buffer.slice(buffer.length - hold);
    return buffer.slice(0, buffer.length - hold);
  }

  /** 保留分を吐き出して終わる。フェンスに入っていれば何も返さない。 */
  flush(): string {
    if (this.suppressed) {
      return "";
    }
    const rest = this.pending;
    this.pending = "";
    return rest;
  }
}

/**
 * text の末尾が marker の先頭何文字に一致しているかを返す。
 *
 * "本文```" と "```state" なら 3（``` の部分）。
 * ここを保留しないと、分割して届いたマーカーを取りこぼす。
 */
function longestPrefixAtEnd(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let n = max; n > 0; n--) {
    if (text.endsWith(marker.slice(0, n))) {
      return n;
    }
  }
  return 0;
}

// ---- 既存 state の修復 ----

/** 重複を解消する対象のキー。id を持つレコードが並ぶもの。 */
const ID_BEARING_KEYS = ["決定", "未決"];

/**
 * state 内で重複している id を振り直す。
 *
 * applyPatch は受信時に衝突を防ぐが、**それ以前に書かれた重複は残る**
 * （実測: D6 と D7 が別内容で2件ずつ存在した）。読み込み時に直す。
 *
 * 先に現れたほうを正とし、後から来たほうを `D6-2` にする。
 * 先勝ちにするのは、既存の決定を指している依存を壊さないため。
 */
export function dedupeIds(state: AgentState): AgentState {
  const next: AgentState = { ...state };

  for (const key of ID_BEARING_KEYS) {
    const list = next[key];
    if (!Array.isArray(list)) {
      continue;
    }

    const seen = new Set<string>();
    let changed = false;
    const fixed = list.map((item) => {
      const id = idOf(item);
      if (id === null) {
        return item;
      }
      if (!seen.has(id)) {
        seen.add(id);
        return item;
      }
      // 衝突。空いている連番を探す。
      let n = 2;
      while (seen.has(`${id}-${n}`)) {
        n += 1;
      }
      const renamed = `${id}-${n}`;
      seen.add(renamed);
      changed = true;
      return { ...(item as Record<string, unknown>), id: renamed };
    });

    if (changed) {
      next[key] = fixed;
    }
  }

  return next;
}
