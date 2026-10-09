// mod-surface-protocol.md の手順 3 段階 B: mod が $.prompt.submit() で始めたターンが stdout にどう流れるかを記録する
//
// 使い方: node probe-prompt-submit.mjs <claude バイナリ> <出力 .jsonl> <push-gate のフォルダ>
//   PROBE_REPLAY=1 で --replay-user-messages を付ける（mod が積んだプロンプトの本文が流れてくるかを見る）
//   PROBE_PARTIAL=1 で --include-partial-messages を付ける（再生されたプロンプトと stream_event の順序を見る）
//
// 一時フォルダに git リポジトリと push 先の bare リポジトリを作り、その中で動かす。外には push しない。
//
// 送る順序:
//   initialize → ui_attach → 「git push して」 → result（push-gate が拒否）
//   → ui_render(AbovePrompt) → ui_press(承認) → push-gate の $.prompt.submit で始まるターン → result
//   → stdin を閉じる
//
// SDK と同じ条件にするため、--permission-prompt-tool=stdio を付けて can_use_tool に答え、
// CLAUDE_CODE_SDK_READS_SESSION_STATE=1 を渡す（SDK 0.3.295 が CLI に渡す値）。
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { writeFileSync, appendFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [bin, outFile, pluginDirArg] = process.argv.slice(2)
if (!bin || !outFile || !pluginDirArg) {
  console.error('usage: node probe-prompt-submit.mjs <claude> <out.jsonl> <push-gate-dir>')
  process.exit(2)
}

const pluginDir = resolve(pluginDirArg)
const base = mkdtempSync(join(tmpdir(), 'probe-prompt-submit-'))
const cwd = join(base, 'work')
const remote = join(base, 'remote.git')
const git = (args, dir = cwd) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()

mkdirSync(cwd)
execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote])
git(['init', '-q', '-b', 'main'])
git(['config', 'user.email', 'probe@example.invalid'])
git(['config', 'user.name', 'probe'])
writeFileSync(join(cwd, 'README.md'), 'probe\n')
git(['add', 'README.md'])
git(['commit', '-q', '-m', 'probe'])
git(['remote', 'add', 'origin', remote])

const SURFACE = 'vscode'
const CLIENT_ID = 'stateful-agent-probe'
const VIEWPORT = { columns: 100, rows: 30, isFullscreen: false }

// 入れ子の Claude Code だと判断されないよう、親セッションの印を外す
const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' }
for (const key of Object.keys(env)) {
  if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_SSE') || key === 'CLAUDE_CODE_IDE_HOST_OVERRIDE') delete env[key]
}

const args = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--plugin-dir', pluginDir,
  // ユーザー設定のフック（calendar-log など）を動かさない
  '--setting-sources', 'project',
  '--no-session-persistence',
  '--model', 'haiku',
  '--permission-prompt-tool=stdio',
  ...(process.env.PROBE_REPLAY === '1' ? ['--replay-user-messages'] : []),
  ...(process.env.PROBE_PARTIAL === '1' ? ['--include-partial-messages'] : []),
]

writeFileSync(outFile, '')
const t0 = Date.now()
const log = entry => appendFileSync(outFile, JSON.stringify({ t: Date.now() - t0, ...entry }) + '\n')
const note = text => {
  log({ dir: 'note', text })
  console.log(`[${Date.now() - t0}ms] ${text}`)
}

const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
log({ dir: 'meta', bin, cwd, args })

const waiters = []
const waitFor = (pred, ms, label) =>
  new Promise(resolve => {
    const w = { pred, resolve }
    waiters.push(w)
    setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) {
        waiters.splice(i, 1)
        note(`timeout: ${label}`)
        resolve(undefined)
      }
    }, ms)
  })

// stdout の 1 行を 1 語で要約する（流れを目で追うため）
function brief(msg) {
  if (msg.type === 'stream_event') return null
  if (msg.type === 'system') return `system/${msg.subtype}${msg.subtype === 'session_state_changed' ? `:${msg.state}` : ''}`
  if (msg.type === 'assistant') {
    const blocks = (msg.message?.content ?? []).map(b => (b.type === 'text' ? `text(${JSON.stringify(b.text.slice(0, 60))})` : b.type === 'tool_use' ? `tool_use(${b.name}: ${JSON.stringify(b.input).slice(0, 80)})` : b.type))
    return `assistant ${blocks.join(' ')}`
  }
  if (msg.type === 'user') {
    const c = msg.message?.content
    const desc = typeof c === 'string' ? `text(${JSON.stringify(c.slice(0, 80))})` : (c ?? []).map(b => (b.type === 'tool_result' ? `tool_result(${JSON.stringify(String(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)).slice(0, 80))})` : `${b.type}(${JSON.stringify((b.text ?? '').slice(0, 80))})`)).join(' ')
    return `user ${desc}${msg.isSynthetic ? ' [synthetic]' : ''}${msg.origin ? ` origin=${JSON.stringify(msg.origin)}` : ''}`
  }
  if (msg.type === 'result') return `result ${msg.subtype} num_turns=${msg.num_turns} cost=${msg.total_cost_usd}`
  if (msg.type === 'control_request') return `control_request ${msg.request?.subtype}`
  if (msg.type === 'control_response') return `control_response ${msg.response?.request_id}`
  return msg.type
}

let streamEvents = 0
createInterface({ input: child.stdout }).on('line', line => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    log({ dir: 'out-raw', line })
    return
  }
  log({ dir: 'out', msg })
  const b = brief(msg)
  if (b === null) streamEvents++
  else note(`out: ${b}${streamEvents > 0 ? ` (この前に stream_event ${streamEvents} 件)` : ''}`)
  if (b !== null) streamEvents = 0
  // SDK の canUseTool の代わりにすべて許可する（一時フォルダの中なので害はない）
  if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { behavior: 'allow', updatedInput: msg.request.input } } })
  } else if (msg.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'probe does not answer' } })
  }
  for (const w of [...waiters]) {
    if (w.pred(msg)) {
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve(msg)
    }
  }
})
createInterface({ input: child.stderr }).on('line', line => log({ dir: 'stderr', line }))

function send(msg) {
  log({ dir: 'in', msg })
  child.stdin.write(JSON.stringify(msg) + '\n')
}

let seq = 0
async function control(request, ms = 30_000) {
  const request_id = `probe_${++seq}`
  const reply = waitFor(m => m.type === 'control_response' && m.response?.request_id === request_id, ms, request.subtype)
  send({ type: 'control_request', request_id, request })
  const r = await reply
  return r?.response
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
const summarize = r => (r?.subtype === 'success' ? r.response : { error: r?.error ?? r })

function findPressables(node, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) findPressables(n, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (node.press && Number.isInteger(node.press.handle)) out.push({ plugin: node.press.plugin, handle: node.press.handle, key: node.props?.key })
  for (const v of Object.values(node)) if (v && typeof v === 'object') findPressables(v, out)
  return out
}

const bandProps = isWorking => ({ hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 95, scroll: { offset: 0, bodyRows: 9 }, view: {} })
const renderBand = isWorking =>
  control({ subtype: 'ui_render', surface: SURFACE, client_id: CLIENT_ID, component: 'AbovePrompt', instance_id: 'above-prompt', props: bandProps(isWorking), viewport: VIEWPORT })

await control({ subtype: 'initialize' })
note(`ui_attach: ${JSON.stringify(summarize(await control({ subtype: 'ui_attach', surface: SURFACE, client_id: CLIENT_ID, viewport: VIEWPORT })))}`)

const first = waitFor(m => m.type === 'result', 180_000, 'result 1')
send({
  type: 'user',
  message: { role: 'user', content: 'Bash ツールで `git push origin main` を 1 回だけ実行してください。ほかのコマンドは実行しないでください。拒否されたら、その理由を 1 文で伝えて終えてください。' },
  parent_tool_use_id: null,
  session_id: '',
})
await first
note(`remote の main（承認前）: ${(() => { try { return git(['--git-dir', remote, 'log', '--oneline', 'main'], base) } catch { return '(なし)' } })()}`)
await sleep(1500)

const band = summarize(await renderBand(false))
note(`帯: ${JSON.stringify(band)}`)
const approve = findPressables(band?.tree).find(p => p.key === 'approve')
if (!approve) {
  note('承認ボタンが見つからない。ここで止める')
} else {
  const second = waitFor(m => m.type === 'result', 180_000, 'result 2')
  note(`ui_press(承認): ${JSON.stringify(summarize(await control({ subtype: 'ui_press', plugin: approve.plugin, handle: approve.handle, key: approve.key, surface: SURFACE, client_id: CLIENT_ID })))}`)
  await second
  // result のあとに来るもの（session_state_changed:idle など）を拾う
  await sleep(3000)
  note(`remote の main（承認後）: ${(() => { try { return git(['--git-dir', remote, 'log', '--oneline', 'main'], base) } catch { return '(なし)' } })()}`)
  note(`帯（承認後）: ${JSON.stringify(summarize(await renderBand(false)))}`)
}

child.stdin.end()
const result = await Promise.race([exited, sleep(15_000).then(() => (child.kill('SIGTERM'), { killed: true }))])
log({ dir: 'meta', exit: result })
note(`exit: ${JSON.stringify(result)}`)
console.log(`done: ${outFile}`)
