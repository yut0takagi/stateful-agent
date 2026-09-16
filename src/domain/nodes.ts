/**
 * state の語彙をドメインモデルとして持つ。
 *
 * ねらいは「ノードが自分の意味を知っている」こと。
 * 以前は graph.ts が `state["決定"]` を読み、graph-view.tsx が
 * 「前提は青」という対応表を持っていた — 意味が2箇所に漏れ、
 * ノード自身は自分が前提なのか結論なのかを知らなかった。
 *
 * ここでは各ノードが次を自分で答える。
 *   - 自分の役割（根拠づけか、結論か、対案か）
 *   - どのノードの前に置けるか（接続の妥当性）
 *   - その接続をなんと呼ぶか（述語）
 *   - どう描かれたいか（**意図**まで。色値は持たない）
 *
 * 描画意図に CSS を持たせない理由: ドメインが表現層に依存すると、
 * テーマを変えるためにドメインを触ることになる。
 * 「補助的に見せたい」まではドメインの言葉、「#888」は View の言葉。
 */

/** ノードが議論の中で担う役割。 */
export type NodeRole =
  /** 根拠づけ — 結論を支える */
  | "grounding"
  /** 結論 — 判断そのもの */
  | "conclusion"
  /** 対案 — 採らなかった道 */
  | "alternative"
  /** 裏付け — 結論が正しいと確かめた手段 */
  | "evidence"
  /** 問い — まだ結論が出ていない */
  | "inquiry";

/** 描画の意図。具体的な色・太さは View が決める。 */
export interface VisualIntent {
  /** 画面内での重み。central は視線を集めたい、supporting は添えたい。 */
  emphasis: "central" | "supporting";
  /** 輪郭の閉じ方。tentative は「まだ動く」ことを示したい。 */
  contour: "solid" | "tentative";
  /** 無効になったことを示したいか（撤回された決定）。 */
  invalidated: boolean;
}

/**
 * state を構成するノードの基底。
 *
 * id と label は共通。役割・層・述語・描画意図は各ノードが決める。
 */
export abstract class StateNode {
  constructor(
    readonly id: string,
    readonly label: string,
  ) {}

  /** 議論の中での役割。 */
  abstract readonly role: NodeRole;

  /** 表示用の分類名。 */
  abstract readonly kindLabel: string;

  /**
   * 読む順序の層。小さいほど手前（左）。
   *
   * 「なぜ（前提） → 何を（決定） → どうなった（却下・検証）」の順に読ませたい。
   * 未決は決定の系列から外れるので最後に置く。
   */
  abstract readonly layer: number;

  /** どう描かれたいか。 */
  abstract get visual(): VisualIntent;

  /**
   * このノードが other の手前に置けるか。
   *
   * 接続の妥当性をノード自身が判断する。呼び出し側が
   * 「前提なら決定へ、決定なら却下へ」と分岐しなくてよい。
   */
  abstract canPrecede(other: StateNode): boolean;

  /**
   * この接続をなんと呼ぶか。繋がらないなら null。
   *
   * 述語は接続の意味なので、接続できるノードが答える。
   */
  abstract predicateTo(other: StateNode): string | null;
}

/** 前提 — 判断が依存している事実・制約。 */
export class Premise extends StateNode {
  readonly role = "grounding" as const;
  readonly kindLabel = "前提";
  readonly layer = 0;

  get visual(): VisualIntent {
    // 前提は決定を支える立場なので、目立たせず添える。
    return { emphasis: "supporting", contour: "solid", invalidated: false };
  }

  canPrecede(other: StateNode): boolean {
    return other instanceof Decision;
  }

  predicateTo(other: StateNode): string | null {
    return this.canPrecede(other) ? "前提" : null;
  }
}

/** 決定の確度。 */
export type DecisionState = "確定" | "暫定" | "撤回";

/** 決定 — 判断そのもの。グラフの中心。 */
export class Decision extends StateNode {
  readonly role = "conclusion" as const;
  readonly kindLabel = "決定";

  constructor(
    id: string,
    label: string,
    /** 省略時は確定として扱う（state 側で省略されることがある）。 */
    readonly decisionState: DecisionState = "確定",
    /** 実際に何をしたか。ツールチップ用。 */
    readonly action?: string,
    /** 台帳に書かれた id。依存の参照に使う。省略されることもある。 */
    readonly ledgerId?: string,
    /** この決定が前提にしている過去の決定の台帳 id。 */
    readonly dependsOn: string[] = [],
  ) {
    super(id, label);
  }

  /**
   * 層は依存の深さで決まるので、レイアウト側から上書きできる。
   *
   * 過去の決定が次の決定の前提になる連鎖を横方向に見せたい。
   * 固定値だと全部同じ列に積まれて連鎖が読めない。
   */
  private depth = 1;

  get layer(): number {
    return this.depth;
  }

  /** 依存の深さを与える（レイアウト時にトポロジカル順で決まる）。 */
  setDepth(depth: number): void {
    this.depth = depth;
  }

  get visual(): VisualIntent {
    return {
      emphasis: "central",
      // 暫定は「覆してよい」ことを輪郭で示す。
      contour: this.decisionState === "暫定" ? "tentative" : "solid",
      invalidated: this.decisionState === "撤回",
    };
  }

  canPrecede(other: StateNode): boolean {
    // 決定 → 決定 は「過去の決定が次の前提になった」関係。
    return (
      other instanceof RejectedOption ||
      other instanceof Verification ||
      other instanceof Decision
    );
  }

  predicateTo(other: StateNode): string | null {
    if (other instanceof RejectedOption) {
      return "却下";
    }
    if (other instanceof Verification) {
      return "検証";
    }
    if (other instanceof Decision) {
      return "前提";
    }
    return null;
  }
}

/** 却下案 — 検討したが採らなかった道。 */
export class RejectedOption extends StateNode {
  readonly role = "alternative" as const;
  readonly kindLabel = "却下";

  /**
   * 親の決定の右隣に置きたいので、層は可変にする。
   *
   * 固定値だと、依存が深くて右にずれた決定の 却下が左に取り残される
   * （実測: 決定 x=688 に対して 却下 x=468 になった）。
   */
  private depth = 2;

  get layer(): number {
    return this.depth;
  }

  setDepth(depth: number): void {
    this.depth = depth;
  }

  get visual(): VisualIntent {
    return { emphasis: "supporting", contour: "solid", invalidated: false };
  }

  // 却下案は終点。ここから先に判断は伸びない。
  canPrecede(_other: StateNode): boolean {
    return false;
  }

  predicateTo(_other: StateNode): string | null {
    return null;
  }
}

/** 検証 — 決定が正しいと確かめた手段。 */
export class Verification extends StateNode {
  readonly role = "evidence" as const;
  readonly kindLabel = "検証";

  /**
   * 親の決定の右隣に置きたいので、層は可変にする。
   *
   * 固定値だと、依存が深くて右にずれた決定の 検証が左に取り残される
   * （実測: 決定 x=688 に対して 検証 x=468 になった）。
   */
  private depth = 2;

  get layer(): number {
    return this.depth;
  }

  setDepth(depth: number): void {
    this.depth = depth;
  }

  get visual(): VisualIntent {
    return { emphasis: "supporting", contour: "solid", invalidated: false };
  }

  canPrecede(_other: StateNode): boolean {
    return false;
  }

  predicateTo(_other: StateNode): string | null {
    return null;
  }
}

/** 未決 — まだ結論が出ていない論点。 */
export class OpenQuestion extends StateNode {
  readonly role = "inquiry" as const;
  readonly kindLabel = "未決";
  readonly layer = 3;

  constructor(
    id: string,
    label: string,
    /** 決めるために必要な情報。 */
    readonly needs?: string,
  ) {
    super(id, label);
  }

  get visual(): VisualIntent {
    // 未決は「まだ閉じていない」ので輪郭を開ける。
    return { emphasis: "supporting", contour: "tentative", invalidated: false };
  }

  canPrecede(_other: StateNode): boolean {
    return false;
  }

  predicateTo(_other: StateNode): string | null {
    return null;
  }
}

/**
 * 台帳（state）のキー名からノードを作る。
 *
 * **台帳の日本語キーを知っているのはこの関数だけ。**
 * ここを通すことで、state の JSON 形式が変わっても
 * ノード側とグラフ側は影響を受けない。
 */
export function nodeFromLedger(
  ledgerKey: string,
  id: string,
  label: string,
  extra?: string,
): StateNode | null {
  switch (ledgerKey) {
    case "前提":
      return new Premise(id, label);
    case "決定":
      return new Decision(id, label, normalizeDecisionState(extra), undefined);
    case "却下":
      return new RejectedOption(id, label);
    case "検証":
      return new Verification(id, label);
    case "未決":
      return new OpenQuestion(id, label, extra);
    default:
      return null;
  }
}

/** state に書かれた状態文字列を語彙に寄せる。語彙外は確定として扱う。 */
export function normalizeDecisionState(raw: unknown): DecisionState {
  return raw === "暫定" || raw === "撤回" || raw === "確定" ? raw : "確定";
}
