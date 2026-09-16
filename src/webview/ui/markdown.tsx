/**
 * Markdown レンダラ。
 *
 * shadcn-chatbot-kit の markdown-renderer.tsx を土台に、VSCode 向けに削ぎ落とした版。
 * 出典: https://github.com/Blazity/shadcn-chatbot-kit (MIT)
 *
 * 素の textContent だったところをここに置き換える。見出し・リスト・コードブロックが出る。
 */

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils.js";

export function MarkdownRenderer({ children }: { children: string }) {
  return (
    <div className="space-y-3">
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </Markdown>
    </div>
  );
}

/** コードブロック。ハイライトは持たないが、等幅・枠・横スクロールは付ける。 */
function CodeBlock({ children, className, ...props }: React.HTMLAttributes<HTMLElement>) {
  const isInline = !className?.includes("language-");

  if (isInline) {
    return (
      <code
        className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[0.9em]"
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <div className="my-2 overflow-x-auto rounded-md border border-border bg-muted">
      <pre className="p-3 font-mono text-[12px] leading-relaxed">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
}

const COMPONENTS = {
  h1: (p: object) => <h1 className="mt-4 mb-2 text-base font-semibold" {...p} />,
  h2: (p: object) => <h2 className="mt-4 mb-2 text-[14px] font-semibold" {...p} />,
  h3: (p: object) => <h3 className="mt-3 mb-1 text-[13px] font-semibold" {...p} />,
  p: (p: object) => <p className="leading-relaxed" {...p} />,
  ul: (p: object) => <ul className="my-1 list-disc space-y-1 pl-5" {...p} />,
  ol: (p: object) => <ol className="my-1 list-decimal space-y-1 pl-5" {...p} />,
  li: (p: object) => <li className="leading-relaxed" {...p} />,
  a: (p: object) => (
    <a className="text-[var(--vscode-textLink-foreground)] underline" {...p} />
  ),
  blockquote: (p: object) => (
    <blockquote className="border-l-2 border-border pl-3 text-muted-foreground" {...p} />
  ),
  table: (p: object) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[12px]" {...p} />
    </div>
  ),
  th: (p: object) => (
    <th className="border border-border bg-muted px-2 py-1 text-left font-semibold" {...p} />
  ),
  td: (p: object) => <td className="border border-border px-2 py-1" {...p} />,
  hr: (p: object) => <hr className="my-3 border-border" {...p} />,
  code: CodeBlock,
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
};

export { cn };
