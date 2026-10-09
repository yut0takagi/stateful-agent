/**
 * mod の画面要素の型と、stdout の振り分けのテスト。
 *
 * 入力は reports/mod-surface-protocol.md の手順 1・2 で CLI 2.1.289 から記録した行をそのまま使う。
 */

import { describe, expect, it } from "vitest";
import { parseNotice, routeLine, textOf, treeOf, unwrapPluginPrompt } from "../src/core/modui.js";

const PREFIX = "stateful_agent_ui_";

describe("routeLine", () => {
  it("自分の request_id への返答は own（SDK に渡さない）", () => {
    const line = JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: `${PREFIX}1`, response: { surfaces: ["vscode"] } },
    });
    const r = routeLine(line, PREFIX);
    expect(r.kind).toBe("own");
    expect(r.kind === "own" && r.response.request_id).toBe(`${PREFIX}1`);
  });

  it("SDK の request_id への返答は response（SDK に渡す）", () => {
    const line = JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: "req_1_abc", response: {} },
    });
    expect(routeLine(line, PREFIX).kind).toBe("response");
  });

  it("トースト・ステータス行・ペインの一覧は notice", () => {
    const toast = routeLine(
      '{"type":"system","subtype":"ui_toast","plugin":"surface-probe","text":"surface-probe: ① トースト","timeout_ms":15000,"uuid":"u","session_id":"s"}',
      PREFIX,
    );
    expect(toast).toEqual({
      kind: "notice",
      notice: { kind: "toast", plugin: "surface-probe", text: "surface-probe: ① トースト", timeoutMs: 15000 },
    });

    const panes = routeLine(
      '{"type":"system","subtype":"ui_panes","panes":[{"id":"surface-probe","title":"surface-probe","plugin":"surface-probe"}],"shown_id":"surface-probe","focused_id":null,"focus_requested_id":null,"uuid":"u","session_id":"s"}',
      PREFIX,
    );
    expect(panes).toEqual({
      kind: "notice",
      notice: {
        kind: "panes",
        panes: [{ id: "surface-probe", title: "surface-probe", plugin: "surface-probe" }],
        shownId: "surface-probe",
      },
    });
  });

  it("assistant や init、JSON でない行は other（そのまま SDK に渡す）", () => {
    expect(routeLine('{"type":"assistant","message":{}}', PREFIX).kind).toBe("other");
    expect(routeLine('{"type":"system","subtype":"init"}', PREFIX).kind).toBe("other");
    expect(routeLine("not json", PREFIX).kind).toBe("other");
  });

  it("形の崩れた ui_ 通知は other（知らない形を描こうとしない）", () => {
    expect(routeLine('{"type":"system","subtype":"ui_toast","plugin":"x"}', PREFIX).kind).toBe("other");
    expect(routeLine('{"type":"system","subtype":"ui_unknown","plugin":"x"}', PREFIX).kind).toBe("other");
  });
});

describe("parseNotice", () => {
  it("ステータス行は text:null で消す", () => {
    expect(parseNotice({ subtype: "ui_status", plugin: "p", text: null })).toEqual({ kind: "status", plugin: "p", text: null });
  });

  it("トーストの timeout_ms が無ければ CLI の既定値 4000", () => {
    expect(parseNotice({ subtype: "ui_toast", plugin: "p", text: "t" })).toEqual({ kind: "toast", plugin: "p", text: "t", timeoutMs: 4000 });
  });

  it("ui_invalidate は名指しの部品を instanceId に直す。instances が無ければ全部", () => {
    expect(
      parseNotice({
        subtype: "ui_invalidate",
        event: "ui.render",
        instances: [{ surface: "vscode", component: "AbovePrompt", instance_id: "above-prompt" }],
      }),
    ).toEqual({ kind: "invalidate", instances: [{ surface: "vscode", component: "AbovePrompt", instanceId: "above-prompt" }] });
    expect(parseNotice({ subtype: "ui_invalidate", event: "ui.render" })).toEqual({ kind: "invalidate" });
  });
});

describe("treeOf / textOf", () => {
  it("mod が CLI に任せた印（engine）は null", () => {
    expect(treeOf({ tree: { type: "engine", ref: 1 }, hooked: true })).toBeNull();
  });

  it("帯の木をそのまま返し、Text の children は連結して読む", () => {
    const tree = treeOf({
      tree: {
        type: "Box",
        children: [
          { type: "Text", children: ["surface-probe: ④ 帯（", "vscode", "）", "", " "] },
          { type: "Button", props: { key: "press", label: "⑤ 押す" }, press: { plugin: "surface-probe", handle: 938879341 } },
        ],
      },
      hooked: true,
    });
    expect(tree?.type).toBe("Box");
    const text = tree?.children?.[0];
    expect(typeof text === "object" && textOf(text.children)).toBe("surface-probe: ④ 帯（vscode） ");
    const button = tree?.children?.[1];
    expect(typeof button === "object" && button.press).toEqual({ plugin: "surface-probe", handle: 938879341 });
  });

  it("木の無い返答は null", () => {
    expect(treeOf(undefined)).toBeNull();
    expect(treeOf({ hooked: false })).toBeNull();
  });
});

describe("unwrapPluginPrompt", () => {
  it("CLI が包んだ文面から、mod が書いた本文だけを取り出す（2.1.295 の実物）", () => {
    const wrapped =
      "The push-gate plugin sent a message:\npush-gate: 承認しました。次のコマンドを、書き換えずにそのまま実行してください。\n\n```sh\ngit push origin main\n```\n\n" +
      "This is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.";
    expect(unwrapPluginPrompt(wrapped)).toBe(
      "push-gate: 承認しました。次のコマンドを、書き換えずにそのまま実行してください。\n\n```sh\ngit push origin main\n```",
    );
  });

  it("文面が変わって当てはまらなければ、そのまま返す", () => {
    expect(unwrapPluginPrompt("push-gate: 承認しました。")).toBe("push-gate: 承認しました。");
  });
});
