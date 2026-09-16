# Stateful Agent

会話履歴の代わりに構造化 state を持ち、規律（OKF・ハーネス）を宣言的に実行する
VSCode/Cursor 拡張。

設計文書は作者の個人 vault 側にあり、このリポジトリには含まない。
出典: [SKILL.state (arXiv:2608.26263)](https://arxiv.org/abs/2608.26263)

## なぜ

Claude Code は会話履歴を捨てられない。`/compact` は要約に置き換えるだけ、
microcompact は古い tool result を消すだけで対話本体は残る。
`.claude/settings.json` の hook（プロセス起動型）が返せるのは
`additionalContext` / `decision` / `permissionDecision` / `continue` で、対話履歴を減らす口がない。

ただし **SDK 側には3つの口がある**（`canUseTool` / `PostToolUse` / `options.agents`）。
実測の結果、コストが動くのはそちらだけだった（下記）。

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

## 実測 — 履歴を切ってもコストは下がらなかった

12ターン × 3モードを同一シナリオで回した結果（`.bench/turns.jsonl`）。

| モード | in | out | cacheRead | cacheCreate | $/turn |
|---|---|---|---|---|---|
| `stateless` | 17 | 8,355 | 452,630 | 58,988 | **1.025** |
| `recent` | 14 | 7,986 | 342,428 | 51,509 | **0.886** |
| `full` | 6 | 8,301 | 410,756 | 20,012 | **0.613** |

コスト構成比にすると、何が起きていたかがはっきりする。

| モード | out | cacheRead | cacheCreate | **in** |
|---|---|---|---|---|
| `stateless` | 26.0% | 28.2% | 45.9% | **0.0%** |
| `recent` | 28.8% | 24.7% | 46.5% | **0.0%** |
| `full` | 38.6% | 38.2% | 23.2% | **0.0%** |

**履歴を切る操作は `inputTokens` にしか効かない。そこがコストの 0.0% だった。**
だから履歴モードを変えても総額が動かなかった。

しかも `full` が**一番安い**（$0.613 < $0.886 < $1.025）。履歴を捨てると
セッションが毎ターン新しくなり、プロンプト前半がキャッシュに乗らないので
`cacheCreate` を毎回払い直す（45.9% vs 23.2%）。
**履歴を捨てる設計はコスト面では損をしていた。**

動いているのは `cacheCreate` + `cacheRead`（6〜7割）である。これはラリー内部で
ツール出力が prefix に積まれ、エージェントループの各ステップで読み直されているぶん。
10ファイル読んで1つが要る調査だと、**残り9ファイルぶんを以降の全ステップで運び続ける。**

`stateless` モードの意義は**コストから意思決定の構造化へ移る**。
「state だけで引き継げるか」を検証する装置としての価値は残るが、
コスト最適化の手段としては撤回する。

## context 予算 — 3つの関門を直列に置く

削減の手は3つあり、**互いに排他ではなく直列**である。
同じツール呼び出しが3つの関門を順に通る。`src/core/contextbudget.ts` が束ねる。

```
 指示 ─┬─[1] 隔離?  ── 調査なら explorer に投げる（出力が主文脈に入らない）
       │              options.agents
       ▼
 ツール呼び出し
       ├─[2] 入力を絞る ── Read に範囲を足す / Bash を head で包む
       │                  canUseTool
       ▼
    ツール実行
       ├─[3] 出力を削る ── 返ってきた出力を中略する
       │                  PostToolUse の updatedToolOutput
       ▼
    モデルに届く
```

| 層 | 介入点 | 何をするか | 効く理由 |
|---|---|---|---|
| **[1] 隔離** | `options.agents` | 調査を explorer に委譲し報告だけ受け取る | 運ぶ量が「読んだ全量」から「結論」に変わる |
| **[2] 入力を絞る** | `canUseTool` | Read に `offset/limit`、Bash に `head` | 取得自体のコストも払わない |
| **[3] 出力を削る** | `PostToolUse` | 中略して差し替える | 絞れなかった分の最後の関門 |

3層とも既定で有効。`statefulAgent.contextBudget.*` で層ごとに切れる。

### 層ごとに会計を分ける

**層をまたいだ合算削減率は出さない。** [2] が絞った出力に [3] がかかるので、
両者の「削った文字数」を足すと元の量を二重に数えることになる。

> 元 10,000 文字 → [2] が 4,000 に絞る → [3] が 3,000 に削る
> これを「6,000 + 1,000 = 7,000 削減」と読むのは誤り。
> 実際の削減は 7,000 だが、2つの層は分母が違うので率に合算できない。

だから UI には層ごとに別々に出す。どれが効いたか分離できないと閾値を動かせない。

### 実測で決める

既定値は**すべて仮置き**である。bench に `--layers` を足したので、
1層ずつ足して効き幅を分離して測れる。

```bash
node dist/bench.mjs --repo <対象> --turns 12 --modes recent                      # 層なし
node dist/bench.mjs --repo <対象> --turns 12 --modes recent --layers narrow       # [2] だけ
node dist/bench.mjs --repo <対象> --turns 12 --modes recent --layers narrow,trim  # [2]+[3]
node dist/bench.mjs --repo <対象> --turns 12 --modes recent --layers all          # 全層
```

### 設計上の判断

**[1] 隔離**

- **編集の指示では隔離しない。** 編集は読んだ内容を主コンテキストに置いたまま
  進めるほうが正確で往復も少ない
- **「調べて直して」は編集扱い。** 混在時は編集を優先する
- **explorer に書き込み系ツールを与えない。** 規律エンジンは主スレッドの
  `canUseTool` に載るので、**サブエージェント経由の書き込みは同じ検査を通らない**
- **モデルを固定しない。** 安いモデルに固定すると探索の判断を誤り、
  主スレッドがその報告を前提に進んで余計な往復が生まれる
- **報告に「わからなかったこと」を必ず書かせる。** 省かれると主スレッドは
  確認済みだと誤解して進む

**[2] 入力を絞る**

- **モデルが自分で `offset`/`limit` を書いているなら触らない。** 意図を持って
  範囲を決めているものを上書きすると、同じ範囲を読み直す往復が増える
- **行数が分からないファイルは触らない。** 推測で範囲を付けると短いファイルの
  後半を理由なく隠すことになる
- **既に絞っているコマンドは触らない**（`head`/`tail`/`wc`/パイプ/リダイレクト）。
  二重に絞ると期待した行数が返らず、原因不明の欠落になる
- **書き込み系・破壊的なコマンドは触らない**（`git commit`/`rm`/`npm install`）
- **規律（`deny`/`ask`）が先。** コスト削減が安全側の判断を上書きしてはいけない

**[3] 出力を削る**

- **頭と尾の両方を残す。** 末尾を捨てると終了状態やファイル末尾の結論が読めず、
  モデルが同じツールを打ち直す。打ち直しは削減分を上回る
- **行境界で切る。** 行途中で切ると壊れた JSON/コードを実在の構文として読む
- **中略を明示し読み直し方を書く**（`offset/limit`・`grep`・`sed -n`）
- **構造が読めない出力は触らない。** 画像等を推測で壊すほうが代償が高い
- **削る必要がなければ差し替えを返さない。** 恒等の差し替えは並行フックの削減と
  last-write-wins で競合しうる（SDK の型注記が明示）

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

`canUseTool` は規律（安全）とコスト（[2] 入力を絞る）の2つを担う。
順序は規律が先。コスト削減が `deny`/`ask` を上書きしてはいけない。

**規律はサブエージェントに継承されない。** だから explorer には
書き込み系ツールを渡さない（渡すと規律を通らない書き込み経路ができる）。

## 次のフェーズ

- **P3**: 規律エディタ（GUI）— `.agent/rules/*.yaml` をファイル直接編集なしで追加・編集する

state インスペクタは実装済み（state パネルの鉛筆アイコンから手編集。
`Cmd + Enter` で保存、`Esc` で取消。壊れた JSON は保存せず編集内容を残す）。

P2（vault 外のリポジトリ対応）は完了。対応表のパスを設定可能にし、
一時ディレクトリでの実ファイル検証を `tests/generic-repo.test.ts` に置いた。

## 未決

- 配布方法（現状は個人利用前提）
- state スキーマのバージョン移行則
- MCP サーバー群（BQ / Slack / Drive）の引き回し
- **context 予算の閾値はすべて仮置き。** `--layers` で1層ずつ測って決める
- **[1] 隔離で総額が下がるか未検証。** サブエージェント側も課金される以上、
  「主からサブへ移るだけ」の可能性がある
- **`shouldDelegate` の判定は正規表現で仮。** 誤って隔離すると編集の精度が落ちる
- **既定モードを `full` にすべきか。** 実測で `full` が最安だったが、
  「履歴を持たない」というプロジェクトの看板と正面から衝突するため保留
