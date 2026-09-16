# Stateful Agent

会話履歴の代わりに構造化 state を持ち、規律（OKF・ハーネス）を宣言的に実行する
VSCode/Cursor 拡張。

設計文書は作者の個人 vault 側にあり、このリポジトリには含まない。
出典: [SKILL.state (arXiv:2608.26263)](https://arxiv.org/abs/2608.26263)

## なぜ

Claude Code は会話履歴を捨てられない。`/compact` は要約に置き換えるだけ、
microcompact は古い tool result を消すだけで対話本体は残る。
hook が返せるのは `additionalContext` / `decision` / `permissionDecision` / `continue` の
4つで、履歴を減らす口がない。

Agent SDK の `query()` は入力が `prompt` と `options` だけで messages 配列を渡す口がない。
つまり `resume` を渡さなければ履歴ゼロで始まる。これを使う。

## 構造

```
Webview(UI) ── extension.ts ── agent.ts ── Agent SDK ── claude.ai OAuth
                     │
                     ├── state.ts    .ctx/state/current.json
                     └── engine.ts   .agent/rules/*.yaml → canUseTool
```

公式拡張は同梱バイナリ(190MB)を子プロセスで起動するが、こちらは SDK を直接呼ぶ。
だから履歴の持ち方を自分で決められる。

## 認証

claude.ai の OAuth（サブスク）をそのまま使う。**API キーは要らない。**
SDK 型に `subscription_type: 'pro'|'max'|'team'|'enterprise'` と
`apiKeySource: 'none'`（= claude.ai OAuth）があり、SDK 側が正規に対応している。

課金は増えないが、レート枠（5時間 / 7日）を消費する。

## 履歴モード

| モード | 送るもの | 用途 |
|---|---|---|
| `stateless` | state + 今回の指示のみ | 定型タスク。論文どおり |
| `recent` | state + 直近Nターン（既定 3） | 既定。探索的なやり取りも成立する |
| `full` | 通常の会話履歴（SDK の resume） | 比較検証用 |

UI 右上のセレクタか `Stateful Agent: 履歴モードを切り替え` で変える。
モードを変えると履歴はクリアされる。

## 規律

`.agent/rules/*.yaml` に書く。既存 hook が `deny` しか持てなかったのに対し、
`canUseTool` の `updatedInput` により **補って通す**ことができる。

| action | 挙動 |
|---|---|
| `deny` | 拒否して理由をモデルに返す |
| `ask` | ユーザーに承認を求める |
| `fill` | 不足を補って通す（例: OKF の type を manifest.yaml から導出） |
| `strip` | 違反部分を除いて通す（例: ナレッジの日付キーを削除） |

作者の vault では `.agent/rules/vault.yaml` に既定規律を6本置いている
（このリポジトリには含まない。各自のリポジトリに `.agent/rules/*.yaml` を置く）。

`type` の対応表は `vault設計/manifest.yaml` が正。ここに複製しない
（複製するとカテゴリ追加時に片方だけ直る事故が起きる）。

### vault 以外のリポジトリで使う

`.agent/rules/*.yaml` を置けば動く。`type` の対応表は次の順に探す。

| 優先 | 場所 |
|---|---|
| 1 | 設定 `statefulAgent.manifestPath`（明示指定。存在しなければ候補に落ちず対応表なしとして扱う） |
| 2 | `.agent/manifest.yaml`（vault 以外の既定） |
| 3 | `vault設計/manifest.yaml`（vault） |

対応表が無いリポジトリでは `fill` の `source: folder_map` が導出できないので、
規律側の `fallback`（`deny` / `ask`）に落ちる。`.agent/rules` 自体が無ければ規律ゼロで素通りする。

`tests/generic-repo.test.ts` が vault の実ファイルを参照せず一時ディレクトリで
この経路を通している。

## 使い方

```bash
npm install
npm run build     # dist/extension.js を作る
npm run check     # 型検査 + テスト173件
npm test          # テストのみ
npm run dev       # ウォッチ
```

### 起動

**このディレクトリ**を VSCode/Cursor で開く（vault ルートではない）。

```bash
cd apps/stateful-agent
cursor .    # または code .
```

デバッグを開始すると、拡張が入った新しいウィンドウが立ち上がる。
`.vscode/launch.json` で vault をワークスペースとして開くようにしてあるので、
`.ctx/state/` と `.agent/rules/` はそのまま読める。

| 方法 | 操作 |
|---|---|
| キーボード | `fn + F5`（MacBook は F5 が輝度キーなので fn が要る） |
| メニュー | 実行 → デバッグの開始 |
| コマンドパレット | `Cmd + Shift + P` → `Debug: Start Debugging` |
| サイドバー | 左の実行とデバッグ（▷アイコン）→ 緑の再生ボタン |

`fn` 無しで F5 を使いたいなら、システム設定 → キーボード →
「F1、F2 などのキーを標準のファンクションキーとして使用」を有効にする。

立ち上がったウィンドウで、アクティビティバーの Stateful Agent アイコンを開く。
「規律 6 本を読み込み」と出れば配線が通っている。
入力欄で `Cmd + Enter` を押すと送信。

### 常用する場合

```bash
npx @vscode/vsce package    # .vsix を作る
code --install-extension stateful-agent-0.1.0.vsix
```

## state

`.ctx/state/current.json`。スキーマは固定しない（キーを増やせる）。

### 何を書くか — 引き継ぎ書として書く

state は作業日誌ではない。次のターンのモデルは履歴を持たず state だけを読むので、
**subagent に作業を委譲するときの引き継ぎ書**として書く。
引き継がれた側が state だけで方針を再検討しながら作業を続けられること、が品質基準。

決定は1件 = 1レコードで積む。

```json
{
  "目的": "いま何を達成しようとしているか",
  "決定": [
    {
      "何を": "manifest 探索順を設定→.agent→vault設計にした",
      "前提": ["vault にのみ vault設計/ がある", "設定ミスは黙って埋もれると困る"],
      "却下": "候補へのフォールバック（ミスが表に出ない）",
      "行動": "resolveManifestPath を追加し extension.ts を配線",
      "検証": "mutation test で破壊を捕まえた",
      "状態": "確定"
    }
  ],
  "未決": [{ "論点": "recent の N", "要る情報": "モード別トークン実測" }],
  "次の一手": "引き継いだ側が最初にやること"
}
```

| フィールド | 必須 | なぜ要るか |
|---|---|---|
| `何を` / `行動` | 必須 | 欠けると何が起きたか復元できない |
| `前提` or `却下` | どちらか必須 | 理由がないと引き継いだ側が再検討できず「先人が決めたから」で固定される |
| `検証` | 推奨 | 確認済みか未確認かを区別する |
| `状態` | 推奨 | `確定` / `暫定` / `撤回`。暫定は覆してよい決定。撤回は消さず残す（同じ間違いを防ぐ） |

`validatePatch` が受信時に検証し、足りない点を UI に警告として出す。
**保存は止めない** — 拒否にするとモデルが形式を外した瞬間に state が一切更新されず、
「質が低い」より悪い「何も残らない」に転ぶ。

state パッチの規約は **システムプロンプト側**（`STATE_PROTOCOL`）に置く。
ユーザープロンプト末尾に書くだけでは守られない — SDK 既定のシステムプロンプト
（`claude_code` preset）は state 規約を知らないので、モデルは通常の応答を返して終わる。
`systemPrompt: { type: 'preset', preset: 'claude_code', append: STATE_PROTOCOL }` で
既定を保ったまま規約を常設する。
空のキーは整形時に落ちるので、使わない項目があってもトークンを食わない。

モデルは応答の最後に次の形でパッチを返す。`null` を書いたキーは削除される。

````
```state
{ "決まったこと": ["..."], "未決": null }
```
````

## ドメイン層

`src/domain/nodes.ts`。**ノードが自分の意味を知っている**ことを目的にした層。

以前は `graph.ts` が `state["決定"]` を読み、`graph-view.tsx` が
「前提は青、決定は緑」という対応表を持っていた。意味が2箇所に漏れ、
ノード自身は自分が前提なのか結論なのかを知らなかった。

```
StateNode (abstract)
  ├── Premise         role: grounding    layer: 0
  ├── Decision        role: conclusion   layer: 1
  ├── RejectedOption  role: alternative  layer: 2
  ├── Verification    role: evidence     layer: 2
  └── OpenQuestion    role: inquiry      layer: 3
```

各ノードが自分で答えること:

| 問い | メソッド／プロパティ |
|---|---|
| 議論上の役割は何か | `role` |
| どのノードの手前に置けるか | `canPrecede(other)` |
| その接続をなんと呼ぶか | `predicateTo(other)` |
| どう描かれたいか | `visual`（意図まで。**色値は持たない**） |
| 何層目か | `layer` |

`buildGraph` は接続の向きを自分で決めず、ノードに聞く（`predicateTo` が
`null` を返せば繋がない）。ここで「前提なら決定へ」と分岐すると、
接続規則が再び組み立て層に漏れる。

### 色をドメインに持たせない理由

ドメインが持つのは「補助的に見せたい（`supporting`）」「まだ動く（`tentative`）」
という**意図**まで。`var(--vscode-charts-blue)` は View の言葉。
ドメインが表現層に依存すると、テーマを変えるためにドメインを触ることになる。

役割 → 色の翻訳表は `graph-view.tsx` の `ROLE_COLOR` だけが持つ。

### 3層の流れ

```
domain/nodes.ts     意味を持つ（Class・メソッドあり）
      ↓ toRenderModel
core/graph.ts       座標を与え、転送可能なプレーン値に訳す
      ↓ postMessage（構造化クローン）
webview/graph-view  role と emphasis を色に翻訳して描く
```

`postMessage` は構造化クローンなので **Class のメソッドは Webview に渡らない**
（`instanceof` も効かない）。そのためドメイン層は拡張プロセス側に留め、
Webview へは訳し終えた描画指示だけを送る。制約だが、
ドメインが表現層のプロセスに漏れないので DDD としても正しい向きになる。

台帳の日本語キー（決定 / 前提 / 却下 / 検証 / 未決）を解釈するのは
`buildGraph` と `nodeFromLedger` だけ。

## state グラフ（オントロジービュー）

台帳型 state を決定・前提・却下案・検証・未決のノードにして、述語をエッジで結ぶ。

```
前提 p1 ─┐
         ├─▶ 決定 D1 ──却下──▶ 代替案A
前提 p2 ─┘        └──検証──▶ mutation test
         ┌─▶ 決定 D2
前提 p1 ─┘   ← p1 が崩れると D1 と D2 の両方が揺れる
```

**同じ前提は1ノードに畳む**（文字列の一致で判定）。これが目的で、
台帳の入れ子では潰れてしまう「どの前提が複数の決定を支えているか」が見える。
前提が覆ったときに何を見直すべきかを辿れる。

state スキーマに前提 ID は持たせない。モデルに ID 管理を強制すると、
その手間が state の質を下げる方に働く。

| 表示 | 意味 |
|---|---|
| 実線の枠 | `確定` |
| 破線の枠 | `暫定`（覆してよい決定） |
| 取り消し線 + 半透明 | `撤回`（消さずに残す） |

レイアウトは層状で、力学モデルは使わない。同じ state なら常に同じ絵になる
（力学モデルだと収束位置が揺れて「前と何が変わったか」が読めない）。
座標計算は拡張側（`core/graph.ts`）が持つので、配置の正しさをテストできる。

### 右端に置く

VSCode の制約で、拡張は secondary side bar（右端）に view を**直接置けない**
（`viewsContainers` は `activitybar` と `panel` のみ。
[microsoft/vscode#151681](https://github.com/microsoft/vscode/issues/151681) で未対応）。

そのため初回だけ手で移動する。

1. アクティビティバーの Stateful Agent を開く
2. `state グラフ` のタイトルを右端（secondary side bar）へドラッグ
3. 以後は VSCode がその位置を覚える

右端が出ていないときは `Cmd + Option + B`（`View: Toggle Secondary Side Bar`）で開く。
`Stateful Agent: state グラフを開く` コマンドでフォーカスも移せる。

## ストリーミング

`includePartialMessages: true` を渡すと SDK が `stream_event` を流す。
これが無いと `assistant` メッセージは完成後に一括で届き、画面が固まったように見える。

本文は `content_block_delta` の `text_delta` だけを拾う（`extractStreamText`）。
`thinking_delta` は載せない — 出すと state フェンスの前に思考が混ざって表示が壊れる。

表示はストリーム側が担うので、確定した `assistant` メッセージでは `onText` を呼ばない
（呼ぶと同じ文が二重に出る）。`response` への積み上げだけを行う。

## 既存 hook との関係

`.claude/settings.json` の hooks はそのまま残す。通常の Claude Code から
vault を触るときに必要だから。二重化は意図的。

| 既存 | 対応する規律 |
|---|---|
| `validate-knowledge.sh` | `okf-type-required`（deny → fill に強化） |
| `pretooluse-guard.sh` | `test-green-required` |
| `check-shikou-write.sh` | `shikou-folder-discipline` |
| `.claude/rules/no-dates-in-knowledge` | `no-dates-in-knowledge`（strip） |
| `.claude/rules/confirm-side-effects` | `confirm-side-effects` |

## 次のフェーズ

- **P3**: 規律エディタ（GUI）— `.agent/rules/*.yaml` をファイル直接編集なしで追加・編集する

state インスペクタは実装済み（state パネルの鉛筆アイコンから手編集。
`Cmd + Enter` で保存、`Esc` で取消。壊れた JSON は保存せず編集内容を残す）。

P2（vault 外のリポジトリ対応）は完了。対応表のパスを設定可能にし、
一時ディレクトリでの実ファイル検証を `tests/generic-repo.test.ts` に置いた。

## 未決

- 配布方法（現状は個人利用前提）
- state スキーマのバージョン移行則
- `recent` の N の既定値（3 は仮。実測して決める）
- MCP サーバー群（BQ / Slack / Drive）の引き回し
