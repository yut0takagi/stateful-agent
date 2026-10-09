/**
 * mod が描いた画面要素（帯・ペイン・ステータス行・トースト）を描く。
 *
 * 木は CLI の ui_render が返したもので、要素の props は文字のマス（列・行）で書かれている。
 * 横は ch、縦は行の高さに直して CSS にする。いま描けるのは Box・Text・Button で、
 * それ以外の要素（Input・Select・Markdown など）は種類名と中身の文字だけを出す。
 *
 * ボタンを押したら onPress を呼ぶだけで、押した結果はここでは持たない。
 * mod の状態が変われば CLI が描き直しを頼み、新しい木が届く。
 */

import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";
import { textOf, type UiChild, type UiElement, type UiPane, type UiPressRef } from "../../core/modui.js";
import { cn } from "../lib/utils.js";

export type PressHandler = (ref: UiPressRef & { key?: string }) => void;

const LINE = 1.4; // 1 行の高さ（em）

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/** 横のマスを CSS の長さに。文字列（"100%" など）はそのまま。 */
const across = (v: unknown): string | undefined => (num(v) !== undefined ? `${num(v)}ch` : str(v));
/** 縦のマスを CSS の長さに。 */
const down = (v: unknown): string | undefined => (num(v) !== undefined ? `${num(v)! * LINE}em` : str(v));

function boxStyle(p: Record<string, unknown>): CSSProperties {
  const border = str(p.borderStyle);
  return {
    display: p.display === "none" ? "none" : "flex",
    // ターミナルの Box と同じく、既定は横並び
    flexDirection: (str(p.flexDirection) as CSSProperties["flexDirection"]) ?? "row",
    flexWrap: str(p.flexWrap) as CSSProperties["flexWrap"],
    alignItems: str(p.alignItems),
    alignSelf: str(p.alignSelf),
    justifyContent: str(p.justifyContent),
    flexGrow: num(p.flexGrow),
    flexShrink: num(p.flexShrink),
    columnGap: across(p.columnGap ?? p.gap),
    rowGap: down(p.rowGap ?? p.gap),
    width: across(p.width),
    height: down(p.height),
    minWidth: across(p.minWidth),
    minHeight: down(p.minHeight),
    paddingTop: down(p.paddingTop ?? p.paddingY ?? p.padding),
    paddingBottom: down(p.paddingBottom ?? p.paddingY ?? p.padding),
    paddingLeft: across(p.paddingLeft ?? p.paddingX ?? p.padding),
    paddingRight: across(p.paddingRight ?? p.paddingX ?? p.padding),
    marginTop: down(p.marginTop ?? p.marginY ?? p.margin),
    marginBottom: down(p.marginBottom ?? p.marginY ?? p.margin),
    marginLeft: across(p.marginLeft ?? p.marginX ?? p.margin),
    marginRight: across(p.marginRight ?? p.marginX ?? p.margin),
    overflow: str(p.overflow) as CSSProperties["overflow"],
    backgroundColor: str(p.backgroundColor),
    ...(border
      ? {
          border: `1px ${border === "double" ? "double" : border === "dashed" ? "dashed" : "solid"} ${str(p.borderColor) ?? "var(--hairline)"}`,
          borderRadius: border === "round" ? 6 : 0,
          opacity: p.borderDimColor === true ? 0.85 : undefined,
        }
      : {}),
  };
}

function textStyle(p: Record<string, unknown>): CSSProperties {
  const wrap = str(p.wrap);
  const truncate = wrap !== undefined && wrap.startsWith("truncate");
  return {
    color: p.inverse === true ? "var(--vscode-editor-background)" : str(p.color),
    backgroundColor: p.inverse === true ? "var(--vscode-editor-foreground)" : str(p.backgroundColor),
    fontWeight: p.bold === true ? 600 : undefined,
    fontStyle: p.italic === true ? "italic" : undefined,
    textDecoration: [p.underline === true && "underline", p.strikethrough === true && "line-through"].filter(Boolean).join(" ") || undefined,
    opacity: p.dimColor === true ? 0.6 : undefined,
    whiteSpace: truncate ? "nowrap" : "pre-wrap",
    overflow: truncate ? "hidden" : undefined,
    textOverflow: truncate ? "ellipsis" : undefined,
    minWidth: truncate ? 0 : undefined,
  };
}

function Children({ items, onPress }: { items: UiChild[] | undefined; onPress: PressHandler }): ReactNode {
  return (items ?? []).map((c, i) =>
    typeof c === "string" ? c : <UiNode key={str(c.props?.key) ?? i} node={c} onPress={onPress} />,
  );
}

/** 要素の木を 1 つ描く。 */
export function UiNode({ node, onPress }: { node: UiElement; onPress: PressHandler }): ReactNode {
  const p = node.props ?? {};
  switch (node.type) {
    case "Box":
      return (
        <div style={boxStyle(p)}>
          <Children items={node.children} onPress={onPress} />
        </div>
      );
    case "Text":
      return (
        <span style={textStyle(p)}>
          <Children items={node.children} onPress={onPress} />
        </span>
      );
    case "Button": {
      const label = str(p.label) ?? textOf(node.children);
      const hotkey = str(p.hotkey);
      const press = node.press;
      return (
        <button
          type="button"
          disabled={!press}
          title={hotkey ? `${label}（${hotkey}）` : label}
          onClick={() => press && onPress({ ...press, ...(str(p.key) ? { key: str(p.key) } : {}) })}
          className={cn(
            "rounded-md px-2.5 py-0.5 text-[11.5px] disabled:opacity-50",
            p.plain === true
              ? "underline-offset-2 hover:underline"
              : p.variant === "primary"
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "border border-border hover:bg-accent",
            p.dimColor === true && "opacity-60",
          )}
        >
          {label}
          {hotkey && <span className="ml-1 opacity-60">{hotkey}</span>}
        </button>
      );
    }
    case "Code":
      return <pre className="whitespace-pre-wrap rounded bg-muted px-2 py-1 text-[11px]">{str(p.source) ?? textOf(node.children)}</pre>;
    default:
      // まだ描けない要素。何が来たかは分かるようにし、中身の文字は落とさない
      return (
        <span className="text-muted-foreground">
          [{node.type}] <Children items={node.children} onPress={onPress} />
        </span>
      );
  }
}

export interface ModPaneView extends UiPane {
  tree: UiElement | null;
}

export interface ModSurfaceViewProps {
  band: UiElement | null;
  panes: ModPaneView[];
  shownId: string | null;
  status: Record<string, string>;
  toasts: Array<{ id: number; plugin: string; text: string }>;
  onPress: PressHandler;
  onShowPane: (id: string) => void;
  onDismissToast: (id: number) => void;
}

/** 入力欄の上に、ペイン・帯・トースト・ステータス行の順で積む。何も無ければ何も描かない。 */
export function ModSurfaceView(props: ModSurfaceViewProps): ReactNode {
  const { band, panes, shownId, status, toasts, onPress } = props;
  const shown = panes.find((p) => p.id === shownId) ?? panes[0];
  const statusLines = Object.entries(status);
  if (!band && panes.length === 0 && toasts.length === 0 && statusLines.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5 px-3 pb-1.5 text-[12px]">
      {shown && (
        <div className="rounded-md border border-border">
          {panes.length > 1 && (
            <div className="flex gap-1 border-b border-border px-1.5 pt-1">
              {panes.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => props.onShowPane(p.id)}
                  className={cn(
                    "rounded-t px-2 py-0.5 text-[11px]",
                    p.id === shown.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p.title}
                </button>
              ))}
            </div>
          )}
          <div className="max-h-[30vh] overflow-y-auto px-2.5 py-2">
            {shown.tree ? <UiNode node={shown.tree} onPress={onPress} /> : <span className="text-muted-foreground">（描画待ち）</span>}
          </div>
        </div>
      )}

      {band && (
        <div className="max-h-[22vh] overflow-y-auto rounded-md border border-border bg-muted px-2.5 py-2">
          <UiNode node={band} onPress={onPress} />
        </div>
      )}

      {toasts.map((t) => (
        <div key={t.id} className="flex items-start gap-2 rounded-md bg-accent px-2.5 py-1.5 text-[11.5px]">
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{t.text}</span>
          <button type="button" title="閉じる" onClick={() => props.onDismissToast(t.id)} className="text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}

      {statusLines.length > 0 && (
        <div className="flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
          {statusLines.map(([plugin, text]) => (
            <span key={plugin} className="whitespace-pre-wrap" title={plugin}>
              {text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
