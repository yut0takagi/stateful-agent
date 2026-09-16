import esbuild from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import { copyFile, readFile } from "node:fs/promises";

/**
 * Tailwind を通すプラグイン。
 *
 * Webview は CSP で外部読み込みが禁止なので、CSS は事前にビルドして
 * バンドルに含める必要がある。CDN の Tailwind は使えない。
 */
const tailwindPlugin = {
  name: "tailwind",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      const css = await readFile(args.path, "utf8");
      const result = await postcss([tailwindcss, autoprefixer]).process(css, {
        from: args.path,
      });
      return { contents: result.css, loader: "css" };
    });
  },
};

const production = process.argv.includes("production");
const watch = process.argv.includes("--watch");

/**
 * ビルドは2本。
 *
 * 1. 拡張本体 (CJS / node) — VSCode 拡張ホストが読む
 * 2. Webview UI (IIFE / browser) — React。拡張とは別プロセス・別グローバルで動く
 *
 * Webview 側は CSP で外部読み込みが禁止なので、React も CSS も全部バンドルして
 * ローカルファイルとして配る。CDN は使えない。
 */
const common = {
  bundle: true,
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
};

const extensionCtx = await esbuild.context({
  ...common,
  entryPoints: ["src/extension.ts"],
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/extension.js",
  // vscode は実行時にホストが供給する。バンドルしてはいけない。
  external: ["vscode"],
});

const webviewCtx = await esbuild.context({
  ...common,
  entryPoints: ["src/webview/main.tsx"],
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "dist/webview.js",
  jsx: "automatic",
  plugins: [tailwindPlugin],
  define: { "process.env.NODE_ENV": production ? '"production"' : '"development"' },
});

// グラフビューはチャットとは別の Webview なので独立したバンドルにする。
const graphCtx = await esbuild.context({
  ...common,
  entryPoints: ["src/webview/graph-main.tsx"],
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "dist/graph.js",
  jsx: "automatic",
  plugins: [tailwindPlugin],
  define: { "process.env.NODE_ENV": production ? '"production"' : '"development"' },
});

// 対照実験ベンチ。拡張とは独立に node から直接実行する。
const benchCtx = await esbuild.context({
  ...common,
  entryPoints: ["src/bench/main.ts"],
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: "dist/bench.mjs",
  // SDK は実行時に動的 import する。バンドルすると ESM/CJS の境界で壊れる。
  external: ["@anthropic-ai/claude-agent-sdk"],
  minify: false,
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch(), graphCtx.watch()]);
} else {
  await Promise.all([
    extensionCtx.rebuild(),
    webviewCtx.rebuild(),
    graphCtx.rebuild(),
    benchCtx.rebuild(),
  ]);
  await Promise.all([
    extensionCtx.dispose(),
    webviewCtx.dispose(),
    graphCtx.dispose(),
    benchCtx.dispose(),
  ]);
}

// 既定シナリオは dist から読むのでコピーしておく
// （バンドル後は import.meta.url が dist/ を指すため）。
await copyFile("src/bench/default.txt", "dist/default.txt");
