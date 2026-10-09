# mod の画面要素を stateful-agent で描く: 調査メモ

Claude Code の mod（関数フックのプラグイン、`~/Develop/mods`）は、トースト・ステータス行・ペイン・ボタンを描ける。しかし公式の VS Code / Cursor 拡張機能（2.1.289）では、これらがひとつも表示されない。stateful-agent を mod の「画面」として CLI に接続し、Webview で描けるかを調べた。結論は「CLI 側に受け口はある。非公開なので版が変わると壊れうるが、試作する価値はある」。

## 分かっていること（実測）

### 公式拡張機能では描かれない

調査用の mod（`/surface-probe`）を公式拡張機能のセッションで動かした結果は次のとおり。

| 項目 | 結果 |
|---|---|
| `$.session.surfaces()` | 空 |
| 環境変数 `CLAUDE_CODE_ENTRYPOINT` | `claude-vscode`（`claude -p` は `sdk-cli`） |
| `$.ui.open()` | `{ isPlaced: true }` を返すが、実際には描かれない |
| `ui.render` フックへの描画依頼 | 0 件（ペインも、プロンプトの上の帯も） |
| トースト・ステータス行・ペイン・帯・ボタン | どれも表示されない |
| `$.audio.play()` | 鳴る |
| コマンドの返答テキスト | 表示される |
| コマンドの `e.origin.kind` | `composer`（人が打った扱い） |
| mod からの `$.prompt.submit()` | 届く（push-gate の承認後の続きが動いた） |
| `tool.call` での拒否・`prompt.submit` での添え書き | 動く |

公式拡張機能は CLI を SDK 経由で起動するが、画面として `ui_attach` を送っていないため、と考えられる。（手順 1 で一部修正: トースト・ステータス行・ペインの一覧は `ui_attach` がなくても届いている。「手順 1 の結果」を参照）

### CLI 本体には画面の受け口がある

公式拡張機能に同梱の CLI（`resources/native-binary/claude`、2.1.289）の文字列から確認した。stream-json の `control_request` の処理に、次の種類が実装されている。スキーマには `@internal` と書かれており、公開の仕様ではない。

| subtype | 向き | 中身（スキーマの記述から） |
|---|---|---|
| `ui_attach` | 画面 → CLI | `surface`（`desktop` / `mobile` / `vscode`）、`client_id`（英数字と `.` `_` `-` で 1〜64 字）、`viewport`（任意。正の整数の列数・行数）、`answers`（任意。この画面が代わりに答える要求: `ui_copy`、`ui_prompt_read`、`ui_prompt_fill` など） |
| `ui_detach` | 画面 → CLI | `client_id` |
| `ui_render` | 画面 → CLI | `surface`、`client_id`（任意）ほか。CLI が mod の `ui.render` をその画面向けに評価し、要素の木と「その部品にフックしている mod があるか」を返す |
| `ui_press` | 画面 → CLI | `plugin`（押された要素を描いた mod）、`handle`（整数。木に入っている `press.handle`）、`key`（任意）、`surface`（任意）、`href`（任意。2048 字まで）。CLI はその mod の `onPress` を実行する |

ほかに、文字列として次の名前も見つかった。役割はまだ確かめていない: `ui_invalidate`（9 か所）、`ui_toast`（5）、`ui_status`（5）、`ui_message`（12）、`ui_panes`（28）、`ui_pane_show`（11）、`ui_input`（15）、`ui_select`（15）、`ui_client_module`、`ui_client_press`、`ui_client_fault`。名前から見て、CLI から画面への「描き直して」「トースト」「ステータス行」の通知と、入力欄・選択の操作と推測できる。

### stateful-agent から制御メッセージを送る口

Agent SDK（0.3.266）の型定義に `ui_attach` などは出てこない。ただし `Options.spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess` が公開されていて、`SpawnedProcess` は `stdin: Writable` を持つ（`sdk.d.ts` 2278 行目・8389 行目付近）。

これを使えば、stateful-agent が CLI を自分で起動できる。

- `stdin` に `ui_attach` / `ui_render` / `ui_press` の `control_request` を書き込む
- `stdout` を分岐させ、自分宛ての `control_response` と `ui_*` の通知は自分で処理し、残りを SDK に渡す

## 試作の手順案

1. **通知の形を確かめる**: CLI を stream-json で起動して `ui_attach`（`surface: "vscode"`）を送る。調査用の mod を読み込ませた状態で、stdout に何が流れてくるか（`ui_invalidate`・`ui_toast`・`ui_status` の形）を記録する。最初は stateful-agent に組み込まず、Node の小さなスクリプトで試すとよい
2. **描画の往復**: `ui_render` でプロンプトの上の帯（`AbovePrompt`）を頼み、返ってきた要素の木を JSON のまま記録する。そのあと `ui_press` でボタンを押し、mod の状態が変わるかを見る
3. **stateful-agent に組み込む**: `spawnClaudeCodeProcess` で起動を差し替え、Webview に要素の木の描画器（Box・Text・Button から始める）を作る
4. **push-gate で通しで確かめる**: push を止める → 帯に承認ボタンが出る → 押す → push が通る

## 手順 1 の結果（2026-10-09 実測）

CLI を stream-json で起動し、surface-probe を `--plugin-dir` で読み込ませて、`/surface-probe` と `/surface-probe clear` を送った。`ui_attach` の有無と `viewport` の書き方を変えて 5 回記録した。使ったスクリプトは `reports/probes/probe-ui-attach.mjs`。

起動に使った引数は `-p --input-format stream-json --output-format stream-json --verbose --plugin-dir <surface-probe> --setting-sources project --no-session-persistence`。`--setting-sources project` は、ユーザー設定のフック（calendar-log など）を動かさないために付けた。mod のコマンドは CLI の中で答えが返り、モデルは呼ばれない（`total_cost_usd: 0`）。

### 回ごとの違い

| 回 | CLI | `ui_attach` | 起きたこと |
|---|---|---|---|
| A | 2.1.289 | 送らない | トースト・ステータス行・ペインの一覧がすべて届く。`$.ui.open()` は「開いた」 |
| B | 2.1.289 | 送らない（起動元を `claude-vscode` にした） | A と同じ |
| C | 2.1.289 | `viewport: { columns, rows }` | トーストとステータス行は届く。ペインは保留され、`ui_panes` は届かない |
| D | 2.1.289 | `viewport: { columns, rows, isFullscreen: false }` | attach の直後に空の `ui_panes` が届き、ペインを開くと 1 件入りの `ui_panes` が届く |
| E | 2.1.294 | C と同じ | C と同じ |

C で `$.ui.open()` が返した保留の理由は次のとおり。

```text
no attached surface places panes (stateful-agent-probe): placed when a surface that does attaches, or once they detach
```

### 分かったこと

1. **トースト・ステータス行・ペインの一覧は、`ui_attach` を送らなくても届く。** CLI がこれらを送る条件は「出力が stream-json で、mod の機能が有効」の 2 つだけで、画面の attach を待たない。CLI の判定（`zi()`）を読んで確かめ、A と B で実測した。公式拡張機能も stream-json で CLI を起動しているので、これらを受け取ったうえで描いていない、と考えられる。`ui_attach` が要るのは、帯やペインの中身を `ui_render` で頼むときと、ボタンを `ui_press` で押すときになる（手順 2 で確かめる）
2. **ペインを置く画面として名乗るには、`viewport` に `isFullscreen` を入れる。** CLI は、`isFullscreen` を持つ attach 済みの画面を「ペインを置く画面」と数える。`isFullscreen` のない `viewport` を送った画面しかないと、ペインは保留される（C）。`viewport` ごと省けば保留されない。stateful-agent は D の形で attach する
3. **`ui_invalidate` は出なかった。** `ui_render` で描いたものがまだないので、古くなるものもない。スキーマの説明では、mod が `$.ui.invalidate` を呼んだとき、mod を読み込んだとき・読み込み直したとき、描画で読んだ状態が書き換わったとき（このときは `instances` 付き）に出る。手順 2 で、`ui_render` のあとに状態を変えて確かめる
4. **`system/init` は、最初のユーザー発話のあとに出る。** `ui_attach` は、`initialize` の直後（init より前）に送っても受け付けられた
5. **2.1.289 と 2.1.294 で、形の違いは見られなかった**

### 記録した形

`ui_attach` への返答:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"probe_2","response":{"surfaces":["vscode"]}}}
```

トースト（`$.ui.toast`）。`timeout_ms` は、mod が `timeoutMs` を渡さなければ 4000 になる:

```json
{"type":"system","subtype":"ui_toast","plugin":"surface-probe","text":"surface-probe: ① トースト","timeout_ms":15000,"uuid":"…","session_id":"…"}
```

ステータス行（`$.ui.status`）。mod ごとに 1 行で、`text: null` が届いたら消す:

```json
{"type":"system","subtype":"ui_status","plugin":"surface-probe","text":"surface-probe: ② ステータス行","uuid":"…","session_id":"…"}
```

ペインの一覧（`$.ui.open` / `$.ui.close`）。差分ではなく、開いているペインの全量が毎回届く:

```json
{"type":"system","subtype":"ui_panes","panes":[{"id":"surface-probe","title":"surface-probe","plugin":"surface-probe"}],"shown_id":"surface-probe","focused_id":null,"focus_requested_id":null,"uuid":"…","session_id":"…"}
```

`ui_detach` への返答は `{"detached":true,"surfaces":[]}`。

まだ届いていないものの形（スキーマから）:

- `ui_invalidate`: `{"type":"system","subtype":"ui_invalidate","event":"ui.render","instances":[{"surface","component","instance_id"}]}`（`instances` は省かれることがあり、そのときは描いたものすべてを頼み直す）
- `ui_log`: `{"type":"system","subtype":"ui_log","plugin","text"}`

### 手順 3 に持ち越す点

- stdout の分岐で stateful-agent が取るのは、自分の `request_id` の `control_response` と、`type: "system"` で subtype が `ui_` で始まる行。SDK（0.3.266）がこれらの行を受け取ったときにどう扱うか（捨てるか、そのまま流すか）は確かめていない

## 手順 2 の結果（2026-10-09 実測）

手順 1 と同じ起動のしかたで、`isFullscreen` 付きで attach したあと、次の順に送った。使ったスクリプトは `reports/probes/probe-ui-render.mjs`。

1. 帯を出す前に `ui_render`（`AbovePrompt`）
2. `/surface-probe` で帯を出す
3. 帯とペインを `ui_render` で頼む
4. 帯の木にあるボタンを `ui_press` で押す
5. 帯を描き直す
6. 押せない条件を試す

2.1.289 の `vscode`・2.1.289 の `desktop`・2.1.294 の `vscode` の 3 通りで、結果は同じだった。

### 分かったこと

1. **`vscode` として頼んでも、帯は描ける。** 型定義には「`AbovePrompt` は terminal と desktop でだけ呼ばれる」とあるが、これは CLI が自分から描きに行く画面の話で、`ui_render` で頼めば `vscode` でも mod のフックが動く。surface-probe の記録にも `AbovePrompt@vscode, Pane@vscode` と残った
2. **ボタンを押すと、mod の状態が変わる。** `ui_press` は `{"handled":true,"element":"press"}` を返し、描き直した帯には「⑤ 押されました」が出た。続けて打った `/surface-probe` も「⑤ ボタン: 押された」と返した
3. **`ui_invalidate` は、描いた部品を名指しして届く。** 帯を一度 `ui_render` で描いたあとは、mod が状態を書くたびに `instances: [{"surface":"vscode","component":"AbovePrompt","instance_id":"above-prompt"}]` が届いた。`ui_press` のときは、押した結果の返答より先に届く。同じ値を書き直しただけでも届く
4. **`handle` は描くたびに変わり、古いものは使えない。** 同じボタンでも、描き直すと `handle` が 1 増えた。描き直す前の `handle` で押すと、key が正しくても `{"handled":false}` が返る。新しい `handle` に別の key を付けた場合も同じ。`handled: false` が返ったら、手元の木が古いので描き直す
5. **mod が描かないときは、CLI に任せる印が返る。** 帯を出す前の `ui_render` は `{"tree":{"type":"engine","ref":1},"hooked":true}` を返した。`hooked: true` は「この部品にフックしている mod がある」という意味。帯を出していない surface-probe は `next(e)` で CLI に任せたので、CLI の描く分（遠隔の画面では何もない）が返った

### 記録した形

`ui_render` の要求（帯）。ペインは `component: "Pane"`、`instance_id` にペインの id（`ui_panes` の `id`）を入れ、`props` を `{ title, isFocused, bodyColumns, placement, scroll, view }` にする:

```json
{"type":"control_request","request_id":"probe_3","request":{"subtype":"ui_render","surface":"vscode","client_id":"stateful-agent-probe","component":"AbovePrompt","instance_id":"above-prompt","props":{"hasSurvey":false,"isWorking":false,"maxRows":10,"bodyColumns":95,"scroll":{"offset":0,"bodyRows":9},"view":{}},"viewport":{"columns":100,"rows":30,"isFullscreen":false}}}
```

帯を出したあとの返答（`response.response`）:

```json
{"tree":{"type":"Box","children":[{"type":"Text","children":["surface-probe: ④ 帯（","vscode","）",""," "]},{"type":"Button","props":{"key":"press","label":"⑤ 押す"},"press":{"plugin":"surface-probe","handle":938879341}}]},"props":{"hasSurvey":false,"isWorking":false,"maxRows":10,"bodyColumns":95,"scroll":{"offset":0,"bodyRows":9},"view":{}},"rewritten":false,"hooked":true}
```

ペインの返答の木は `{"type":"Text","children":["surface-probe: ③ ペイン（","vscode","）"]}`。

`ui_press` の要求。`plugin` と `handle` は木の `press` から、`key` はボタンの `props.key` から取る:

```json
{"type":"control_request","request_id":"probe_6","request":{"subtype":"ui_press","plugin":"surface-probe","handle":938879341,"key":"press","surface":"vscode","client_id":"stateful-agent-probe"}}
```

返答は `{"handled":true,"element":"press"}`。押せなかったときは `{"handled":false}`。

### 手順 3 に持ち越す点

- 描画器の最初の範囲: `Box`（`children`）、`Text`（`children` は文字列の配列。空文字も混ざるので連結して描く）、`Button`（`props.key`・`props.label`・`press`）。surface-probe は `Box` の props（並べる向きや枠など）を使っていないので、それらの形は push-gate など実物の mod で確かめる
- 画面側の流れ: attach したら帯（`above-prompt`）と、`ui_panes` にある各ペインを `ui_render` で描く。`ui_invalidate` が来たら、名指しされたものを描き直す（`instances` がなければ全部）。押すときは最新の木の `handle` を使い、`handled: false` なら描き直す
- `hooked: false` が返った部品は、次の `ui_invalidate` まで頼まなくてよい（スキーマの説明）

## 手順 3 の進み具合（2026-10-09）

手順 3 は 2 段に分けた。段階 A では、いまの作り（1 ターンごとに CLI を起動する）のまま、ターン中に届く画面要素を描く。段階 B で、ターンのあとも CLI を残す作りに変える。段階 A まで終わった。

### 組み込む前に分かったこと

1. **CLI はターンが終わると止まる。** SDK はプロンプトが文字列のとき「1 ターンで終わる問い合わせ」として扱い、最初の `result` で stdin を閉じる。stateful-agent は毎ターン文字列で `query()` を呼ぶので、CLI はターンごとに起動して止まる。push-gate は拒否したあとに帯で承認を待ち、押されたら `$.prompt.submit()` で続きを始めるので、段階 A では承認まで届かない
2. **SDK 0.3.266 に同梱の CLI（2.1.266）では mod が動かない。** mod は一覧には載るが、フックのモジュールが動かず（コマンドが未知扱い）、`ui_attach` も `Unsupported control request subtype` で断られた。SDK を 0.3.295（同梱 CLI 2.1.295）に上げた。あわせて、使う CLI を設定 `statefulAgent.claudeExecutable` で指せるようにした
3. **SDK は `ui_*` の通知をメッセージとしてそのまま流す。** agent.ts は知らない種類として読み流すので、害はない。SDK が知らない request_id への `control_response` は、上限つきの表に黙ってしまわれる。それでも、自分宛ての返答は stdout から抜き取り、SDK には渡さない

### 作ったもの

| ファイル | 役目 |
|---|---|
| `src/core/modui.ts` | 通知と要素の木の型、stdout の 1 行の振り分け。Webview からも使う |
| `src/core/modsurface.ts` | `spawnClaudeCodeProcess` で CLI の起動を差し替える。SDK の initialize に CLI が答えたあとで `ui_attach`（`isFullscreen` 付き）を送り、帯とペインを `ui_render` で描く。`ui_invalidate` で描き直し、押すときは `ui_press` を送る。CLI が断ったら `unavailable` を出し、以後は何も頼まない |
| `src/core/agent.ts` | `spawnClaudeCodeProcess` と CLI の場所を SDK に渡す口 |
| `src/extension.ts` | ターンごとに接続を作り、Webview とつなぐ。`ui_press` を送るのは、Webview のボタンが押されたときだけ |
| `src/webview/ui/mod-surface.tsx` | 入力欄の上に、ペイン・帯・トースト・ステータス行を描く。`Box`・`Text`・`Button` は props を CSS に写し、それ以外の要素は種類名と中身の文字だけを出す |

版の追従（注意点の 1 つ目）は、版の番号ではなく `ui_attach` が通るかで判断する形にした。断られたら画面要素は出さず、これまでどおり返答テキストだけで動く。

### 確かめたこと

- **テスト:** `tests/modui.test.ts`・`tests/modsurface.test.ts` の 25 件を追加し、既存の 316 件と合わせてすべて通った。typecheck とビルドも通った
- **本物の SDK と CLI での往復:** stateful-agent の `ModSurface` を、SDK 0.3.295 の `query()`（文字列プロンプト）と同梱 CLI 2.1.295 で動かした。確認用の mod（コマンドを受けたら 6 秒待ち、その間は帯に押した回数を出す）を読み込ませると、`ui_attach` → 帯の描画 → `ui_press` → `ui_invalidate` → 描き直しが進み、帯の数字が 0 → 1 → 2 と変わった。`result` の約 1 秒後に CLI が止まり、`closed` が出た
- **描画:** push-gate と同じ形の木を React のサーバー側描画で描き、例外が出ないことと HTML の中身を確かめた。VS Code の画面での見た目は、まだ確かめていない

確かめる途中で、mod 側の挙動を 1 つ見た。確認用の mod は、6 秒待ったあとで押した回数を読み直したが、0 のままだった（帯には 2 と出ていた）。1 つのフックの中で読む状態は、フックが始まった時点のままに見える。確かめてはいない。

### 段階 B に持ち越す点

- プロンプトを文字列から AsyncIterable に変え、`result` のあとも stdin を閉じない。次のターンを始めるとき（または拡張を閉じるとき）に古い CLI を閉じ、新しく起動する。これで履歴を持たない前提は保たれる
- mod が `$.prompt.submit()` で始めたターン（push-gate の承認後の続き）は古い CLI の中で動く。その出力の表示と state パッチの適用を受ける口を作る
- 帯の `isWorking` は、いまは常に `true` で送っている。ターンのあとも CLI を残すなら、ターン中かどうかで切り替える

## 注意点

- **版の追従**: `@internal` の仕様なので、Claude Code の更新で黙って変わりうる。最初の接続で版を確かめ、知らない版なら画面要素を諦めて今の動き（返答テキスト）に戻す作りにしておく
- **承認の安全性**: push-gate の承認は「人がボタンを押した」ことが前提。stateful-agent の Webview から送る `ui_press` は人の操作だけにつなげ、モデルや自動処理からは送らない
- **公式拡張機能との併用**: 同じセッションを公式拡張機能と stateful-agent の両方で開くことはしない（`client_id` の扱いが未検証）

## 関連する状況

- mod の置き場所: `~/Develop/mods`（9 本。まだコミットなし、GitHub にも未公開）。auto-worktree はここで作った
- 公式拡張機能向けには、画面がないときは中身をコマンドの返答テキストで返すように直す方針（B 案）で決まっている。対象は side-question・session-diff・pr-pane・usage-meter・branch-watch の一覧、push-gate の拒否文面
- rtk の書き換えフックは改変するとハッシュの照合で全コマンドが止まる。ワークツリーのセッションで `rtk git` が拒否される問題は、フックを触らない方法で別に直す必要がある
