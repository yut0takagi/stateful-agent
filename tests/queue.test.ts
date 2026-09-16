/**
 * 送信キューのテスト。
 *
 * 実行中でもメッセージを投げられるようにする。
 * 投げたものが消えないこと、順序が保たれることを保証する。
 */

import { describe, expect, it } from "vitest";
import { SendQueue } from "../src/core/queue.js";

describe("SendQueue", () => {
  it("空のときは取り出せない", () => {
    const q = new SendQueue();
    expect(q.shift()).toBeNull();
    expect(q.size).toBe(0);
  });

  it("入れた順に取り出せる", () => {
    const q = new SendQueue();
    q.push("1つ目");
    q.push("2つ目");
    expect(q.shift()).toBe("1つ目");
    expect(q.shift()).toBe("2つ目");
    expect(q.shift()).toBeNull();
  });

  it("件数を数えられる（UI に「N件待機」と出すため）", () => {
    const q = new SendQueue();
    q.push("a");
    q.push("b");
    expect(q.size).toBe(2);
    q.shift();
    expect(q.size).toBe(1);
  });

  it("空文字は入れない（誤送信で空ターンが走らないように）", () => {
    const q = new SendQueue();
    q.push("");
    q.push("   ");
    expect(q.size).toBe(0);
  });

  it("前後の空白は落とす", () => {
    const q = new SendQueue();
    q.push("  指示  ");
    expect(q.shift()).toBe("指示");
  });

  it("待機中の一覧を見られる（何を投げたか確認できるように）", () => {
    const q = new SendQueue();
    q.push("a");
    q.push("b");
    expect(q.peekAll()).toEqual(["a", "b"]);
  });

  it("peekAll は複製を返す（外から壊されない）", () => {
    const q = new SendQueue();
    q.push("a");
    q.peekAll().push("割り込み");
    expect(q.size).toBe(1);
  });

  it("まとめて捨てられる（中断したときに残らないように）", () => {
    const q = new SendQueue();
    q.push("a");
    q.push("b");
    const dropped = q.clear();
    expect(dropped).toEqual(["a", "b"]);
    expect(q.size).toBe(0);
  });

  it("上限を超えたら古いものから捨てる（無限に溜めない）", () => {
    const q = new SendQueue(2);
    q.push("1");
    q.push("2");
    q.push("3");
    expect(q.peekAll()).toEqual(["2", "3"]);
  });
});
