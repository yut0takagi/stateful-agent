// mod-surface-protocol.md の手順 1: CLI を stream-json で起動し、ui_attach の前後で stdout に何が流れるかを JSONL に記録する
//
// 使い方: node probe-ui-attach.mjs <claude バイナリ> <mode> <出力 .jsonl> <mod のフォルダ>
//   mode: noattach     ui_attach を送らない
//         attach       viewport を columns・rows だけで送る（ペインは保留される）
//         attach-panes viewport に isFullscreen を付け、ペインを置く画面として名乗る
//   環境変数 PROBE_ENTRYPOINT で CLAUDE_CODE_ENTRYPOINT を変えられる（既定は sdk-ts）
//
// 送る順序: initialize → (ui_attach) → /surface-probe → /surface-probe clear → (ui_detach)
// mod のコマンドは CLI の中で答えるのでモデルは呼ばれないが、念のため haiku・1 ターンに絞っている
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { writeFileSync, appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MODES = ['noattach', 'attach', 'attach-panes']
const [bin, mode, outFile, pluginDirArg] = process.argv.slice(2)
if (!bin || !MODES.includes(mode) || !outFile || !pluginDirArg) {
  console.error(`usage: node probe-ui-attach.mjs <claude> <${MODES.join('|')}> <out.jsonl> <plugin-dir>`)
  process.exit(2)
}

const pluginDir = resolve(pluginDirArg)
const cwd = mkdtempSync(join(tmpdir(), 'probe-ui-attach-'))
const CLIENT_ID = 'stateful-agent-probe'

// 入れ子の Claude Code だと判断されないよう、親セッションの印を外す
const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: process.env.PROBE_ENTRYPOINT ?? 'sdk-ts' }
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
  '--max-turns', '1',
]

writeFileSync(outFile, '')
const t0 = Date.now()
const log = entry => appendFileSync(outFile, JSON.stringify({ t: Date.now() - t0, ...entry }) + '\n')

const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
log({ dir: 'meta', bin, mode, entrypoint: env.CLAUDE_CODE_ENTRYPOINT, args })

const waiters = []
const waitFor = (pred, ms, label) =>
  new Promise(resolve => {
    const w = { pred, resolve }
    waiters.push(w)
    setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) {
        waiters.splice(i, 1)
        log({ dir: 'meta', timeout: label })
        resolve(undefined)
      }
    }, ms)
  })

createInterface({ input: child.stdout }).on('line', line => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    log({ dir: 'out-raw', line })
    return
  }
  log({ dir: 'out', msg })
  // CLI からの要求には答えないと止まるので、断りを返しておく
  if (msg.type === 'control_request') {
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
  return reply
}

async function prompt(text, ms = 90_000) {
  const done = waitFor(m => m.type === 'result', ms, `result of ${text}`)
  send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
  return done
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))

await control({ subtype: 'initialize' })
if (mode !== 'noattach') {
  const viewport = { columns: 100, rows: 30, ...(mode === 'attach-panes' && { isFullscreen: false }) }
  await control({ subtype: 'ui_attach', surface: 'vscode', client_id: CLIENT_ID, viewport })
}
await sleep(2000)
await prompt('/surface-probe')
await sleep(3000)
await prompt('/surface-probe clear')
await sleep(1500)
if (mode !== 'noattach') {
  await control({ subtype: 'ui_detach', client_id: CLIENT_ID })
  await sleep(500)
}
child.stdin.end()
const result = await Promise.race([exited, sleep(15_000).then(() => (child.kill('SIGTERM'), { killed: true }))])
log({ dir: 'meta', exit: result })
console.log(`done: ${outFile}`, result)
