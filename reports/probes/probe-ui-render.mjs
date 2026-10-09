// mod-surface-protocol.md の手順 2: ui_render で帯とペインの要素の木を頼み、ui_press でボタンを押して、往復を JSONL に記録する
//
// 使い方: node probe-ui-render.mjs <claude バイナリ> <surface> <出力 .jsonl> <mod のフォルダ>
//   surface: vscode | desktop（型定義では AbovePrompt は terminal と desktop でだけ呼ばれる）
//
// 送る順序:
//   initialize → ui_attach → ui_render(AbovePrompt: 帯を出す前) → /surface-probe → ui_render(AbovePrompt, Pane)
//   → ui_press(木の中の最初のボタン) → ui_render(AbovePrompt) → /surface-probe → /surface-probe clear → ui_detach
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { writeFileSync, appendFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SURFACES = ['vscode', 'desktop']
const [bin, surface, outFile, pluginDirArg] = process.argv.slice(2)
if (!bin || !SURFACES.includes(surface) || !outFile || !pluginDirArg) {
  console.error(`usage: node probe-ui-render.mjs <claude> <${SURFACES.join('|')}> <out.jsonl> <plugin-dir>`)
  process.exit(2)
}

const pluginDir = resolve(pluginDirArg)
const cwd = mkdtempSync(join(tmpdir(), 'probe-ui-render-'))
const CLIENT_ID = 'stateful-agent-probe'
const VIEWPORT = { columns: 100, rows: 30, isFullscreen: false }

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
const note = text => {
  log({ dir: 'note', text })
  console.log(`[${Date.now() - t0}ms] ${text}`)
}

const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
log({ dir: 'meta', bin, surface, entrypoint: env.CLAUDE_CODE_ENTRYPOINT, args })

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

const invalidates = []
createInterface({ input: child.stdout }).on('line', line => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    log({ dir: 'out-raw', line })
    return
  }
  log({ dir: 'out', msg })
  if (msg.type === 'system' && msg.subtype === 'ui_invalidate') {
    invalidates.push(msg)
    note(`ui_invalidate: ${JSON.stringify(msg.instances ?? '(instances なし)')}`)
  }
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
  const r = await reply
  return r?.response
}

async function prompt(text, ms = 90_000) {
  const done = waitFor(m => m.type === 'result', ms, `result of ${text}`)
  send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
  return done
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))

const scroll = { offset: 0, bodyRows: 9 }
const bandProps = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 95, scroll, view: {} }
const paneProps = { title: 'surface-probe', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }

const render = (component, instance_id, props) =>
  control({ subtype: 'ui_render', surface, client_id: CLIENT_ID, component, instance_id, props, viewport: VIEWPORT })

// 木の中から押せる要素（press.handle を持つもの）を探す。plugin は最も近い祖先が持つ値を使う
function findPressables(node, plugin, out = []) {
  if (Array.isArray(node)) {
    for (const n of node) findPressables(n, plugin, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  const here = typeof node.plugin === 'string' ? node.plugin : plugin
  if (node.press && typeof node.press === 'object' && Number.isInteger(node.press.handle)) {
    out.push({ plugin: node.press.plugin ?? here, handle: node.press.handle, key: node.key ?? node.props?.key })
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') findPressables(v, here, out)
  return out
}

const summarize = r => (r?.subtype === 'success' ? r.response : { error: r?.error ?? r })

await control({ subtype: 'initialize' })
note(`ui_attach: ${JSON.stringify(summarize(await control({ subtype: 'ui_attach', surface, client_id: CLIENT_ID, viewport: VIEWPORT })))}`)

const before = summarize(await render('AbovePrompt', 'above-prompt', bandProps))
note(`ui_render AbovePrompt (帯を出す前): ${JSON.stringify(before)}`)

await prompt('/surface-probe')
await sleep(1500)

const band = summarize(await render('AbovePrompt', 'above-prompt', bandProps))
note(`ui_render AbovePrompt (帯を出したあと): ${JSON.stringify(band)}`)
const pane = summarize(await render('Pane', 'surface-probe', paneProps))
note(`ui_render Pane: ${JSON.stringify(pane)}`)

const pressables = findPressables(band?.tree)
note(`押せる要素: ${JSON.stringify(pressables)}`)
if (pressables.length > 0) {
  const p = pressables[0]
  const invalidatesBefore = invalidates.length
  const pressed = summarize(
    await control({ subtype: 'ui_press', plugin: p.plugin, handle: p.handle, ...(p.key && { key: p.key }), surface, client_id: CLIENT_ID }),
  )
  note(`ui_press: ${JSON.stringify(pressed)}`)
  await sleep(1000)
  note(`押したあとの ui_invalidate: ${invalidates.length - invalidatesBefore} 件`)
  const after = summarize(await render('AbovePrompt', 'above-prompt', bandProps))
  note(`ui_render AbovePrompt (押したあと): ${JSON.stringify(after)}`)

  // 描き直したあと、古い木の handle で押すと通るか（key は正しいまま）
  const stale = summarize(
    await control({ subtype: 'ui_press', plugin: p.plugin, handle: p.handle, ...(p.key && { key: p.key }), surface, client_id: CLIENT_ID }),
  )
  note(`ui_press (古い handle・正しい key): ${JSON.stringify(stale)}`)

  // 新しい木の handle に、別の key を付けて押すと断られるか
  const fresh = findPressables(after?.tree)[0]
  if (fresh) {
    const wrongKey = summarize(
      await control({ subtype: 'ui_press', plugin: fresh.plugin, handle: fresh.handle, key: 'no-such-key', surface, client_id: CLIENT_ID }),
    )
    note(`ui_press (新しい handle・別の key): ${JSON.stringify(wrongKey)}`)
  }
}

const report = await prompt('/surface-probe')
note(`/surface-probe の返答:\n${report?.result ?? '(なし)'}`)
await sleep(500)
await prompt('/surface-probe clear')
await sleep(1000)
note(`ui_detach: ${JSON.stringify(summarize(await control({ subtype: 'ui_detach', client_id: CLIENT_ID })))}`)
await sleep(500)

child.stdin.end()
const result = await Promise.race([exited, sleep(15_000).then(() => (child.kill('SIGTERM'), { killed: true }))])
log({ dir: 'meta', exit: result })
console.log(`done: ${outFile}`, result)
