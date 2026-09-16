/**
 * state グラフの描画。
 *
 * **この層は「前提とは何か」を知らない。**
 * 受け取るのはドメインが訳した描画指示（role / emphasis / contour / invalidated）で、
 * それを色・太さ・破線に翻訳するだけ。意味の判断はドメイン（domain/nodes.ts）にある。
 *
 * 色は VSCode のテーマ変数を使う。ここが唯一 CSS を知っている場所で、
 * テーマを変えたくなってもドメインには触らない。
 *
 * 外部ライブラリは使わない — Webview は CSP で外部読み込みが禁止で、
 * d3 や cytoscape をバンドルすると数百KB増える。層状レイアウトなら SVG で足りる。
 */

import { useState } from "react";
import { clipToWidth } from "../../core/graph.js";
import type { GraphEdge, RenderNode } from "../../core/graph.js";

const NODE_WIDTH = 168;
const NODE_HEIGHT = 46;

/**
 * 役割 → 色の翻訳表。
 *
 * ドメインの語彙（grounding / conclusion / …）を受けて色を決める。
 * ドメイン側に色を持たせないのは、テーマ変更でドメインを触りたくないから。
 */
const ROLE_COLOR: Record<string, string> = {
  grounding: "var(--vscode-charts-blue)",
  conclusion: "var(--vscode-charts-green)",
  alternative: "var(--vscode-charts-red)",
  evidence: "var(--vscode-charts-purple)",
  inquiry: "var(--vscode-charts-orange)",
};

const FALLBACK_COLOR = "var(--vscode-descriptionForeground)";

/**
 * ノードに収まる文字幅（全角換算）。
 *
 * 幅 168px / 文字サイズ 11.5px なので全角なら約 14 文字。
 * 左右の余白 9px ずつを引いて 12 に抑える。
 */
const LABEL_WIDTH = 12;

export interface GraphViewProps {
  nodes: RenderNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export function GraphView({ nodes, edges, width, height }: GraphViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (nodes.length === 0) {
    return (
      <div className="p-4 text-[12px] italic text-muted-foreground">
        まだ決定が記録されていない。
        <br />
        対話を進めると、決定・前提・却下案の関係がここに出る。
      </div>
    );
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));

  const selected = selectedId === null ? null : (byId.get(selectedId) ?? null);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto p-2">
        <svg width={width} height={height} className="max-w-none">
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={FALLBACK_COLOR} />
          </marker>
        </defs>

        {edges.map((e, i) => {
          const from = byId.get(e.from);
          const to = byId.get(e.to);
          if (!from || !to) {
            return null;
          }
          const x1 = from.x + NODE_WIDTH;
          const y1 = from.y + NODE_HEIGHT / 2;
          const x2 = to.x;
          const y2 = to.y + NODE_HEIGHT / 2;
          // 横に伸ばしてから縦に寄せる曲線。直線だと列をまたぐ線が重なって読めない。
          const mid = (x1 + x2) / 2;
          return (
            <path
              key={i}
              d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke={FALLBACK_COLOR}
              strokeWidth="1"
              strokeOpacity="0.5"
              markerEnd="url(#arrow)"
            />
          );
        })}

        {nodes.map((n) => {
          const color = ROLE_COLOR[n.role] ?? FALLBACK_COLOR;
          const selected = n.id === selectedId;
          return (
            <g
              key={n.id}
              opacity={n.invalidated ? 0.45 : 1}
              onClick={() => setSelectedId(selected ? null : n.id)}
              className="cursor-pointer"
            >
              <title>
                {[n.kindLabel, n.label, n.badge, n.detail].filter(Boolean).join(" / ")}
              </title>
              <rect
                x={n.x}
                y={n.y}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx="6"
                fill={
                  n.emphasis === "central"
                    ? "var(--vscode-editor-background)"
                    : "var(--vscode-editorWidget-background)"
                }
                stroke={color}
                strokeWidth={selected ? 2.6 : n.emphasis === "central" ? 1.6 : 1}
                strokeDasharray={n.contour === "tentative" ? "4 3" : undefined}
              />
              <text
                x={n.x + 9}
                y={n.y + 17}
                fontSize="9"
                fill={color}
                className="uppercase tracking-wider"
              >
                {clipToWidth(n.badge ? `${n.kindLabel} · ${n.badge}` : n.kindLabel, 14)}
              </text>
              <text
                x={n.x + 9}
                y={n.y + 33}
                fontSize="11.5"
                fill="var(--vscode-foreground)"
                textDecoration={n.invalidated ? "line-through" : undefined}
              >
                {clipToWidth(n.label, LABEL_WIDTH)}
              </text>
            </g>
          );
        })}
        </svg>
      </div>

      {selected && <NodeDetail node={selected} edges={edges} byId={byId} />}
    </div>
  );
}

/**
 * 選択したノードの詳細。
 *
 * 図の中では幅に収まる分しか出せないので、全文と関係はここで見せる。
 * tooltip は「触れば出る」が読み返せないため、固定パネルにする。
 */
function NodeDetail({
  node,
  edges,
  byId,
}: {
  node: RenderNode;
  edges: GraphEdge[];
  byId: Map<string, RenderNode>;
}) {
  // このノードを支えているもの / このノードから伸びるもの
  const incoming = edges.filter((e) => e.to === node.id);
  const outgoing = edges.filter((e) => e.from === node.id);
  const color = ROLE_COLOR[node.role] ?? FALLBACK_COLOR;

  return (
    <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-border bg-muted px-3 py-2.5 text-[12px]">
      <div className="mb-1 flex items-center gap-1.5">
        <span
          className="rounded px-1.5 py-px text-[10px] uppercase tracking-wider"
          style={{ color, border: `1px solid ${color}` }}
        >
          {node.kindLabel}
        </span>
        {node.badge && (
          <span className="text-[10.5px] text-muted-foreground">{node.badge}</span>
        )}
        {node.invalidated && (
          <span className="text-[10.5px] text-destructive">撤回済み</span>
        )}
      </div>

      <div className="whitespace-pre-wrap break-words leading-relaxed text-foreground">
        {node.label}
      </div>

      {node.detail && (
        <div className="mt-1.5 whitespace-pre-wrap break-words text-[11.5px] text-muted-foreground">
          {node.detail}
        </div>
      )}

      {incoming.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            これを支えているもの
          </div>
          {incoming.map((e, i) => (
            <div key={i} className="break-words pt-0.5 text-[11.5px]">
              <span className="text-muted-foreground">{e.label}: </span>
              {byId.get(e.from)?.label ?? e.from}
            </div>
          ))}
        </div>
      )}

      {outgoing.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            ここから伸びるもの
          </div>
          {outgoing.map((e, i) => (
            <div key={i} className="break-words pt-0.5 text-[11.5px]">
              <span className="text-muted-foreground">{e.label}: </span>
              {byId.get(e.to)?.label ?? e.to}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
