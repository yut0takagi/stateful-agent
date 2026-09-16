/**
 * グラフビューのエントリ。
 *
 * チャットとは別の Webview（別プロセス）なので、独立したバンドルにする。
 * 拡張から postMessage でレイアウト済みのグラフを受け取って描くだけ。
 * 座標計算は拡張側（core/graph.ts）が持つ — Webview を薄くしておくと
 * レイアウトの正しさをテストできる。
 */

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { GraphView } from "./ui/graph-view.js";
import type { GraphEdge, RenderNode } from "../core/graph.js";
import "./styles.css";

interface GraphMessage {
  type: "graph";
  nodes: RenderNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

function GraphApp() {
  const [graph, setGraph] = useState<GraphMessage | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as GraphMessage;
      if (m?.type === "graph") {
        setGraph(m);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <GraphView
      nodes={graph?.nodes ?? []}
      edges={graph?.edges ?? []}
      width={graph?.width ?? 100}
      height={graph?.height ?? 100}
    />
  );
}

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(<GraphApp />);
}
