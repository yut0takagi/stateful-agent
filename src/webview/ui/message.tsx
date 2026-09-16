/**
 * チャットの吹き出し。
 *
 * shadcn-chatbot-kit の chat-message.tsx を土台に、cva のバリアント構造だけ残して
 * VSCode 向けに作り直した版。出典: https://github.com/Blazity/shadcn-chatbot-kit (MIT)
 */

import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils.js";
import { MarkdownRenderer } from "./markdown.js";

const bubbleVariants = cva(
  "relative break-words rounded-lg text-sm animate-in fade-in-0 duration-200",
  {
    variants: {
      isUser: {
        // 自分の発言は枠線だけ。塗ると画面が重くなる
        true: "border-l-2 border-[var(--vscode-textLink-foreground)] pl-3 text-foreground/90",
        false: "text-foreground",
      },
    },
    defaultVariants: { isUser: false },
  },
);

export interface ChatMessageProps extends VariantProps<typeof bubbleVariants> {
  content: string;
  /** ストリーミング中はカーソルを出す。 */
  streaming?: boolean;
}

export function ChatMessage({ content, isUser, streaming }: ChatMessageProps) {
  return (
    <div className="mb-4">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {isUser ? "あなた" : "エージェント"}
      </div>
      <div className={cn(bubbleVariants({ isUser }))}>
        {isUser ? (
          <div className="whitespace-pre-wrap">{content}</div>
        ) : (
          <MarkdownRenderer>{content}</MarkdownRenderer>
        )}
        {streaming && <span className="ml-0.5 animate-pulse opacity-50">▍</span>}
      </div>
    </div>
  );
}

/** 応答待ちの3点。shadcn-chatbot-kit の typing-indicator 相当。 */
export function TypingIndicator() {
  return (
    <div className="mb-4 flex gap-1 px-1">
      {[0, 90, 180].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-typing-dot-bounce"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}
