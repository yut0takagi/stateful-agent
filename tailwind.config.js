/**
 * Tailwind の設定。
 *
 * 色は固定値を置かず、全部 VSCode のテーマ変数に紐づける。
 * shadcn のトークン名（background / foreground / muted …）はそのまま使えるので、
 * shadcn のコンポーネントを持ってきても VSCode のテーマに馴染む。
 */
export default {
  content: ["./src/webview/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "var(--hairline)",
        input: "var(--vscode-input-background)",
        ring: "var(--vscode-focusBorder)",
        background: "var(--vscode-sideBar-background, transparent)",
        foreground: "var(--vscode-foreground)",
        primary: {
          DEFAULT: "var(--vscode-button-background)",
          foreground: "var(--vscode-button-foreground)",
        },
        muted: {
          DEFAULT: "var(--surface)",
          foreground: "var(--muted-fg)",
        },
        accent: {
          DEFAULT: "var(--vscode-toolbar-hoverBackground)",
          foreground: "var(--vscode-foreground)",
        },
        destructive: {
          DEFAULT: "var(--vscode-errorForeground)",
          foreground: "var(--vscode-foreground)",
        },
        // 差分の背景は薄く敷きたいので、透明度を後付けできる形にする。
        // 素の var() だと Tailwind の /15 が効かず、べた塗りになる。
        add: "rgb(var(--add-rgb) / <alpha-value>)",
        del: "rgb(var(--del-rgb) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--vscode-font-family)"],
        mono: ["var(--vscode-editor-font-family)", "monospace"],
      },
      borderRadius: { lg: "8px", md: "6px", sm: "4px" },
      keyframes: {
        "typing-dot-bounce": {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-3px)" },
        },
      },
      animation: { "typing-dot-bounce": "typing-dot-bounce 1.1s infinite" },
    },
  },
  plugins: [],
};
