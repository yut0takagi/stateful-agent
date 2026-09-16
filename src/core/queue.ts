/**
 * 送信待ちの指示を溜めるキュー。
 *
 * 実行中でも入力を受け付けたい。走っている間は投げたものを捨てるのではなく、
 * ここに積んで終わり次第つなげて実行する。
 *
 * 拡張側に置く。Webview 側に持つと、再読み込みで待機中の指示が消える。
 *
 * VSCode API に依存させない（テスト可能にするため）。
 */

/** 溜めておく上限。これを超えたら古いものから捨てる。 */
const DEFAULT_LIMIT = 20;

export class SendQueue {
  private items: string[] = [];

  constructor(private readonly limit: number = DEFAULT_LIMIT) {}

  get size(): number {
    return this.items.length;
  }

  /**
   * 指示を積む。空文字は無視する。
   *
   * 上限を超えたら**古いもの**から捨てる。新しい指示のほうが
   * いまの意図に近いので、そちらを残す。
   */
  push(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    this.items.push(trimmed);
    while (this.items.length > this.limit) {
      this.items.shift();
    }
  }

  /** 先頭を取り出す。空なら null。 */
  shift(): string | null {
    return this.items.shift() ?? null;
  }

  /** 待機中の一覧。複製を返すので、外から書き換えられても壊れない。 */
  peekAll(): string[] {
    return [...this.items];
  }

  /** 全部捨てて、捨てたものを返す。中断時に残さないため。 */
  clear(): string[] {
    const dropped = this.items;
    this.items = [];
    return dropped;
  }
}
