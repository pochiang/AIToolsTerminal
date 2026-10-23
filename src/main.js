const { app, BrowserWindow, ipcMain, dialog, clipboard, Notification, Menu, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const pty = require('@lydell/node-pty')
const usage = require('./usage')
const { createCollab } = require('./collab')
const gitOps = require('./git')
const { readRepo, workingDiff, showCommit } = gitOps
const { updateCli } = require('./updater')
const selfUpdate = require('./self-update')

// Markers of a parent Claude Code session (when this app is started from one);
// children that inherit them think they are nested and stop saving transcripts.
for (const k of [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT', 'ELECTRON_RUN_AS_NODE',
]) delete process.env[k]

const TOKEN = crypto.randomBytes(16).toString('hex')
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json')
// External processes can't read inside app.asar; the bridge ships unpacked beside it.
const MCP_BRIDGE = path.join(__dirname, 'mcp-bridge.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1').replace(/\\/g, '/')
// The bridge runs on this app's own runtime, so no separate Node.js is needed.
const NODE_RUNTIME = process.execPath.replace(/\\/g, '/')
const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions')

let win = null
let hookPort = 0
let activeId = null
// While last launch's tabs are being reopened, don't overwrite the saved list with a partial one.
let restoring = false
let seq = 0
const sessions = new Map()
const usageState = { claude: { loading: true }, codex: { loading: true } }

// ---------- config ----------

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} }
}
const config = Object.assign({ cwd: os.homedir(), recentDirs: [] }, loadConfig())
function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}
// Open tabs, so the next launch can reopen them and resume their conversations.
function saveTabs() {
  if (restoring) return
  const list = [...sessions.values()]
  config.tabs = list.map(s => ({ kind: s.kind, cwd: s.cwd, customTitle: s.customTitle, autoTitle: s.autoTitle, convId: s.convId, aiOpened: s.aiOpened }))
  config.activeTab = list.findIndex(s => s.id === activeId)
  saveConfig()
}
function rememberDir(dir) {
  config.cwd = dir
  config.recentDirs = [dir, ...config.recentDirs.filter(d => d.toLowerCase() !== dir.toLowerCase())].slice(0, 8)
  saveConfig()
}

// ---------- helpers ----------

const send = (channel, ...args) => win && !win.isDestroyed() && win.webContents.send(channel, ...args)
const titleOf = s => s.customTitle || s.autoTitle || s.folder

const collab = createCollab({
  sessions,
  config,
  saveConfig,
  send,
  update: s => send('session:update', publicSession(s)),
  titleOf,
  spawn: spawnSession,
  cancelSpawns,
})

// The renderer owns terminal creation, so ask it to open a background tab.
// A request settles as soon as the session exists (see session:create); once
// settled (timed out, cancelled), a late create for it is refused.
const spawns = new Map()
let spawnSeq = 0
function spawnSession(kind, cwd, signal) {
  return new Promise(resolve => {
    if (!win || win.isDestroyed()) return resolve({ error: '視窗未開啟' })
    const req = `p${++spawnSeq}`
    const timer = setTimeout(() => spawns.get(req)?.({ error: '開啟逾時' }), 60000)
    spawns.set(req, r => {
      clearTimeout(timer)
      spawns.delete(req)
      resolve(r)
    })
    signal.abort = () => spawns.get(req)?.({ error: '已取消' })
    send('session:spawn', req, kind, { cwd, aiOpened: true, spawnReq: req })
  })
}
function cancelSpawns() {
  for (const settle of [...spawns.values()]) settle({ error: '使用者已停止協作' })
}

function resolveExe(name) {
  try {
    const out = execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true })
    const hits = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    return hits.find(h => /\.exe$/i.test(h)) || hits.find(h => /\.(cmd|bat)$/i.test(h)) || hits[0] || null
  } catch {
    return null
  }
}

function publicSession(s) {
  const { pty: _p, codex: _c, outBuf: _o, oscTail: _t, shellTail: _st, ...rest } = s
  return { ...rest, title: titleOf(s), collab: collab.describe(s) }
}

/**
 * The topic from a title the CLI sets (OSC 0/2): Claude writes `✳ <topic>`,
 * Codex `<topic> | <folder>`; both prefix a spinner while working.
 */
function topicFromTitle(raw, s) {
  const generic = new Set(['claude', 'claude code', 'codex', s.folder.toLowerCase()])
  const parts = raw
    .split('|')
    .map(p => p.replace(/^[\s⠀-⣿✳✻✽✶✢·*◐◑◒◓○●]+/u, '').trim())
    .filter(p => p && !generic.has(p.toLowerCase()) && !/[\\/]|\.exe$/i.test(p))
  return parts[0] ? parts[0].slice(0, 80) : null
}

function watchTitle(s, data) {
  const text = s.oscTail + data
  s.oscTail = ''
  for (const m of text.matchAll(/\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
    // Codex titles itself `[ . ] Action Required` while an approval prompt is up.
    if (/Action Required/i.test(m[1])) {
      if (s.status === 'working') {
        s.awaitingApproval = true
        setStatus(s, 'waiting', '需要你核准操作')
      }
      continue
    }
    if (s.awaitingApproval && s.status === 'waiting') {
      s.awaitingApproval = false
      setStatus(s, 'working', '')
    }
    const topic = topicFromTitle(m[1], s)
    if (topic && topic !== s.autoTitle) {
      s.autoTitle = topic
      send('session:update', publicSession(s))
      saveTabs()
    }
  }
  // Keep an OSC sequence split across chunks for the next one.
  const open = text.lastIndexOf('\x1b]')
  if (open >= 0 && !/\x07|\x1b\\/.test(text.slice(open + 2)) && text.length - open < 512) s.oscTail = text.slice(open)
}

function setStatus(s, status, detail) {
  // A closed session's pty still exits afterwards; an update for it would make
  // the renderer adopt it as a session being created.
  if (sessions.get(s.id) !== s) return
  const changed = s.status !== status
  s.status = status
  s.detail = detail
  if (changed) s.since = Date.now()
  if (changed && status === 'done') {
    s.doneSeq++
    // A turn that answered another session reports back there; don't flag it
    // as finished here, just go quietly back to waiting.
    if (collab.onDone(s, detail === '已中斷')) {
      s.status = 'waiting'
      s.detail = ''
      send('session:update', publicSession(s))
      return
    }
  }
  send('session:update', publicSession(s))
  if (changed && (status === 'done' || (status === 'waiting' && s.everWorked))) notify(s)
}

function notify(s) {
  const focused = win && !win.isDestroyed() && win.isFocused()
  if (focused && activeId === s.id) return
  if (win && !focused) win.flashFrame(true)
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: `${publicSession(s).title}：${s.status === 'done' ? '完成' : '等待中'}`,
    body: s.detail,
    silent: false,
  })
  n.on('click', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    send('session:select', s.id)
  })
  n.show()
}

/**
 * Per-session Claude settings: hooks POST their stdin payload to the hook
 * server with Windows' built-in curl, which works from both cmd and bash.
 */
function claudeHookSettings(id) {
  const cmd = ev => [{
    type: 'command',
    command: `curl.exe -s -m 3 -X POST -H "x-aitt-token: ${TOKEN}" -H "content-type: application/json" --data-binary @- "http://127.0.0.1:${hookPort}/hook?session=${id}&event=${ev}" || exit 0`,
    timeout: 5,
  }]
  const settings = {
    // The status line receives the context window size and usage; report it.
    statusLine: { type: 'command', command: cmd('StatusLine')[0].command, padding: 0 },
    // The tool's top bar already shows quotas; drop the in-terminal usage band.
    enabledPlugins: { 'usage-bars@gkkc6-mods': false },
    permissions: { allow: ['mcp__aitt__list_sessions', 'mcp__aitt__ask_session', 'mcp__aitt__open_session'] },
    hooks: {
      UserPromptSubmit: [{ hooks: cmd('UserPromptSubmit') }],
      PostToolUse: [{ matcher: '*', hooks: cmd('PostToolUse') }],
      Notification: [{ hooks: cmd('Notification') }],
      Stop: [{ hooks: cmd('Stop') }],
      SessionEnd: [{ hooks: cmd('SessionEnd') }],
    },
  }
  const file = path.join(app.getPath('userData'), 'mcp', `${id}-settings.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(settings, null, 2))
  return file
}

/** Last assistant text in a Claude transcript, for the status card. */
function lastClaudeReply(transcript) {
  try {
    const lines = usage.tail(transcript, 256 * 1024).split('\n').reverse()
    for (const line of lines) {
      if (!line.includes('"assistant"')) continue
      const msg = JSON.parse(line)
      if (msg.type !== 'assistant') continue
      const text = (msg.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
      if (text) return text
    }
  } catch {}
  return null
}

/** Context fill of a Claude conversation from its last assistant turn's usage. */
function claudeContext(transcript, window) {
  try {
    const lines = usage.tail(transcript, 256 * 1024).split('\n').reverse()
    for (const line of lines) {
      if (!line.includes('"usage"')) continue
      const msg = JSON.parse(line)
      const u = msg.type === 'assistant' && !msg.isSidechain && msg.message?.usage
      if (!u) continue
      const used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
      return { used, window: window || 200000 }
    }
  } catch {}
  return null
}

function setContext(s, ctx) {
  if (!ctx || !(ctx.window > 0) || (s.context && s.context.used === ctx.used && s.context.window === ctx.window)) return false
  s.context = ctx
  return true
}

// ---------- CLI updates ----------

const updateState = { claude: { state: 'pending' }, codex: { state: 'pending' } }
const updating = {}

function startUpdates() {
  for (const kind of ['claude', 'codex']) {
    updateState[kind] = { state: 'updating' }
    send('update:state', updateState)
    updating[kind] = updateCli(resolveExe(kind)).then(r => {
      updateState[kind] = r
      send('update:state', updateState)
    })
  }
}

// ---------- sessions ----------

function createSession(kind, cwd, cols, rows, restore = {}) {
  // A plain terminal: PowerShell 7 when installed, else Windows PowerShell.
  const exeName = kind === 'shell' ? 'powershell' : kind
  const exe = (kind === 'shell' && resolveExe('pwsh')) || resolveExe(exeName)
  if (!exe) throw new Error(`找不到 ${exeName} 指令，請確認已安裝並在 PATH 中`)
  if (!fs.existsSync(cwd)) throw new Error(`資料夾不存在：${cwd}`)

  const id = `s${++seq}`
  const mcpEnv = { AITT_PORT: String(hookPort), AITT_SESSION: id, AITT_TOKEN: TOKEN }
  const bridgeEnv = { ...mcpEnv, ELECTRON_RUN_AS_NODE: '1' }
  // Room for the longest collaboration wait, plus slack.
  const toolTimeoutSec = config.collab.timeoutMin * 60 + 120
  let args
  if (kind === 'claude') {
    const mcpFile = path.join(app.getPath('userData'), 'mcp', `${id}.json`)
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true })
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { aitt: { type: 'stdio', command: NODE_RUNTIME, args: [MCP_BRIDGE], env: bridgeEnv } } }, null, 2))
    args = ['--settings', claudeHookSettings(id), '--mcp-config', mcpFile]
    if (restore.convId) args.push('--resume', restore.convId)
  } else if (kind === 'codex') {
    const env = Object.entries(bridgeEnv).map(([k, v]) => `${k}="${v}"`).join(',')
    args = [
      '-c', `mcp_servers.aitt.command="${NODE_RUNTIME}"`,
      '-c', `mcp_servers.aitt.args=["${MCP_BRIDGE}"]`,
      '-c', `mcp_servers.aitt.env={${env}}`,
      '-c', `mcp_servers.aitt.tool_timeout_sec=${toolTimeoutSec}`,
      // The relay enforces its own limits; don't stop for approval on every call.
      '-c', 'mcp_servers.aitt.default_tools_approval_mode="approve"',
      // Stay in the normal buffer so the wheel scrolls history instead of
      // being turned into arrow keys that page through Codex's input history.
      '--no-alt-screen',
    ]
    if (restore.convId) args.unshift('resume', restore.convId)
  } else {
    args = ['-NoLogo', '-NoExit', '-EncodedCommand', SHELL_INTEGRATION]
  }
  let file = exe
  if (/\.(cmd|bat)$/i.test(exe)) {
    file = process.env.ComSpec || 'cmd.exe'
    args = ['/c', exe, ...args]
  }

  const env = { ...process.env, ...mcpEnv, COLORTERM: 'truecolor', MCP_TOOL_TIMEOUT: String(toolTimeoutSec * 1000) }

  const p = pty.spawn(file, args, { name: 'xterm-256color', cols: cols || 120, rows: rows || 30, cwd, env, useConpty: true })
  const s = {
    id,
    kind,
    folder: path.basename(cwd) || cwd,
    autoTitle: restore.autoTitle || null,
    customTitle: restore.customTitle || null,
    convId: restore.convId || null,
    aiOpened: !!restore.aiOpened,
    cwd,
    status: 'waiting',
    detail: '',
    since: Date.now(),
    startedAt: Date.now(),
    everWorked: false,
    exited: false,
    lastPrompt: null,
    lastReply: null,
    tokens: null,
    context: null,
    pty: p,
    outBuf: '',
    oscTail: '',
    inputAt: 0,
    doneSeq: 0,
    asksThisTurn: 0,
    serving: null,
    waitingOn: null,
    codex: kind === 'codex' ? { file: null, offset: 0, partial: '' } : null,
  }
  sessions.set(id, s)
  // A resumed Codex conversation keeps writing to its old log; skip what's already there.
  const oldLog = kind === 'codex' && restore.convId && findRolloutById(restore.convId)
  if (oldLog) {
    claimed.add(oldLog)
    s.codex.file = oldLog
    try { s.codex.offset = fs.statSync(oldLog).size } catch {}
  }

  p.onData(data => {
    s.lastOutputAt = Date.now()
    // Keep the mouse for selecting text: drop requests to capture it.
    data = data.replace(MOUSE_MODE_RE, '')
    send('pty:data', id, data)
    // A shell's title is just its path; keep the folder name.
    if (kind !== 'shell') watchTitle(s, data)
    if (kind === 'codex') watchCodexApproval(s, data)
    if (kind === 'shell') watchShell(s, data)
  })
  p.onExit(({ exitCode }) => {
    s.exited = true
    s.pty = null
    setStatus(s, 'done', `程序已結束（代碼 ${exitCode}）`)
  })
  rememberDir(cwd)
  saveTabs()
  return publicSession(s)
}

// Terminal tabs run shell-integration.ps1 (as -EncodedCommand, which also works
// from inside the asar and under any execution policy), so each command is
// marked: OSC 133;C;<base64 command> when it starts, 133;D;<exit code> when done.
const SHELL_INTEGRATION = Buffer.from(fs.readFileSync(path.join(__dirname, 'shell-integration.ps1'), 'utf8'), 'utf16le').toString('base64')
const SHELL_MARK_START = '\x1b]133;'
const SHELL_MARK_RE =/\x1b\]133;([CD]);?([^\x07\x1b]*)(?:\x07|\x1b\\)/g
// Shorter commands (ls, cd) go straight back to waiting: no flash, no notification.
const QUICK_COMMAND_MS = 10000
function watchShell(s, data) {
  const text = (s.shellTail || '') + data
  s.shellTail = ''
  for (const m of text.matchAll(SHELL_MARK_RE)) {
    if (m[1] === 'C') {
      const cmd = Buffer.from(m[2], 'base64').toString('utf8').trim()
      s.commandAt = Date.now()
      s.lastPrompt = cmd.slice(0, 500)
      setStatus(s, 'working', cmd.slice(0, 120))
    } else if (s.status === 'working') {
      const code = Number(m[2]) || 0
      const cmd = s.lastPrompt.slice(0, 120)
      if (Date.now() - s.commandAt < QUICK_COMMAND_MS) setStatus(s, 'waiting', '')
      else setStatus(s, 'done', code ? `失敗（代碼 ${code}）：${cmd}` : cmd)
    }
  }
  // Keep a mark split across chunks for the next one.
  const tail = text.slice(text.lastIndexOf('\x1b'))
  if (tail.startsWith('\x1b') && tail.length < 4096 &&
      (SHELL_MARK_START.startsWith(tail) || (tail.startsWith(SHELL_MARK_START) && !tail.includes('\x07')))) s.shellTail = tail
}

// DECSET/DECRST for mouse reporting (Codex turns on 1003 "any motion"), which
// would send drags to the app instead of selecting text.
const MOUSE_MODE_RE = /\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1015|1016)(?:;(?:1000|1001|1002|1003|1005|1006|1015|1016))*[hl]/g

// Codex does not log approval prompts, so watch the screen for them.
const APPROVAL_RE = /Would you like to (run|make|apply|grant|allow)|Yes, proceed|Allow command\?|Approve this/i
function watchCodexApproval(s, data) {
  if (s.status !== 'working' || Date.now() - s.inputAt < 1500) return
  s.outBuf = (s.outBuf + data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]/g, '')).slice(-4000)
  if (APPROVAL_RE.test(s.outBuf)) {
    s.outBuf = ''
    s.awaitingApproval = true
    setStatus(s, 'waiting', '需要你核准操作')
  }
}

// ---------- Claude hook server ----------

function handleHook({ session, event, payload }) {
  const s = sessions.get(session)
  if (!s) return
  if (payload.session_id && payload.session_id !== s.convId) {
    s.convId = payload.session_id
    saveTabs()
  }
  if (event === 'StatusLine') {
    const cw = payload.context_window
    const cu = cw?.current_usage
    const window = cw?.context_window_size
    let ctx = null
    if (window && cu) ctx = { used: (cu.input_tokens || 0) + (cu.cache_creation_input_tokens || 0) + (cu.cache_read_input_tokens || 0), window }
    else if (window && typeof cw.used_percentage === 'number') ctx = { used: Math.round(window * cw.used_percentage / 100), window }
    else if (payload.transcript_path) ctx = claudeContext(payload.transcript_path, window || s.context?.window)
    if (setContext(s, ctx)) send('session:update', publicSession(s))
    return
  }
  // Fallback when no status line runs (e.g. another one overrides it).
  if ((event === 'PostToolUse' || event === 'Stop') && payload.transcript_path)
    setContext(s, claudeContext(payload.transcript_path, s.context?.window))
  switch (event) {
    case 'UserPromptSubmit':
      s.everWorked = true
      if (payload.prompt) s.lastPrompt = String(payload.prompt).slice(0, 500)
      setStatus(s, 'working', '')
      break
    case 'PostToolUse':
      if (s.status === 'waiting') setStatus(s, 'working', '')
      break
    case 'Notification': {
      const type = payload.notification_type || ''
      const msg = payload.message || ''
      if (type === 'idle_prompt' || /waiting for your input/i.test(msg)) {
        if (s.status === 'working') setStatus(s, 'waiting', '')
      } else if (type === 'permission_prompt' || /permission|approv/i.test(msg)) {
        setStatus(s, 'waiting', '需要權限確認')
      } else if (s.status === 'working') {
        setStatus(s, 'waiting', msg || '需要你的回應')
      }
      break
    }
    case 'Stop':
      s.lastReply = payload.last_assistant_message || (payload.transcript_path && lastClaudeReply(payload.transcript_path)) || s.lastReply
      setStatus(s, 'done', '')
      break
    case 'SessionEnd':
      setStatus(s, 'done', '對話已結束')
      break
  }
}

function startHookServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method !== 'POST' || !['/hook', '/mcp/call'].includes(url.pathname) || req.headers['x-aitt-token'] !== TOKEN) {
        res.writeHead(403).end()
        return
      }
      let body = ''
      req.setEncoding('utf8')
      req.on('data', c => (body += c))
      req.on('end', async () => {
        if (url.pathname === '/hook') {
          // Claude hook: the session and event ride in the URL, the payload is the body.
          res.writeHead(204).end()
          let payload = {}
          try { payload = JSON.parse(body) } catch {}
          handleHook({ session: url.searchParams.get('session'), event: url.searchParams.get('event'), payload })
          return
        }
        let msg
        try { msg = JSON.parse(body) } catch { return res.writeHead(400).end() }
        // An MCP tool call; ask_session holds the response open until the reply.
        const signal = {}
        res.on('close', () => { if (!res.writableEnded) signal.abort?.() })
        const result = await collab.call(msg.session, msg.tool, msg.args || {}, signal)
        if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
      })
    })
    server.requestTimeout = 0
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

// ---------- Codex session log watcher ----------

const claimed = new Set()
function localDateDir(d) {
  const p = n => String(n).padStart(2, '0')
  return path.join(CODEX_SESSIONS, String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()))
}
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

function findRollout(s) {
  const dirs = [localDateDir(new Date()), localDateDir(new Date(Date.now() - 86400000))]
  const candidates = []
  for (const dir of dirs) {
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue
      const file = path.join(dir, n)
      if (claimed.has(file)) continue
      const st = fs.statSync(file)
      if (st.mtimeMs < s.startedAt - 5000) continue
      candidates.push({ file, t: st.birthtimeMs || st.mtimeMs })
    }
  }
  candidates.sort((a, b) => a.t - b.t)
  for (const c of candidates) {
    try {
      const fd = fs.openSync(c.file, 'r')
      const buf = Buffer.alloc(8192)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      const head = buf.toString('utf8', 0, n)
      const cwd = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/)
      const ts = head.match(/"payload":\{.*?"timestamp":"([^"]+)"/)
      if (!cwd || !samePath(JSON.parse(`"${cwd[1]}"`), s.cwd)) continue
      if (ts && Date.parse(ts[1]) < s.startedAt - 5000) continue
      return c.file
    } catch {}
  }
  return null
}

function findRolloutById(convId) {
  const sub = dir => { try { return fs.readdirSync(dir).sort().reverse() } catch { return [] } }
  for (const y of sub(CODEX_SESSIONS))
    for (const m of sub(path.join(CODEX_SESSIONS, y)))
      for (const d of sub(path.join(CODEX_SESSIONS, y, m))) {
        const name = sub(path.join(CODEX_SESSIONS, y, m, d)).find(n => n.endsWith(`${convId}.jsonl`))
        if (name) return path.join(CODEX_SESSIONS, y, m, d, name)
      }
  return null
}

function handleCodexLine(s, obj) {
  const p = obj.payload || {}
  if (obj.type === 'event_msg') {
    if (p.type === 'task_started') {
      s.everWorked = true
      s.awaitingApproval = false
      setStatus(s, 'working', '')
    } else if (p.type === 'task_complete') {
      if (p.last_agent_message) s.lastReply = String(p.last_agent_message)
      setStatus(s, 'done', '')
    } else if (p.type === 'turn_aborted') {
      setStatus(s, 'done', '已中斷')
    } else if (p.type === 'token_count') {
      const total = p.info?.total_token_usage?.total_tokens
      if (total) s.tokens = total
      const last = p.info?.last_token_usage?.total_tokens
      if (last != null && p.info?.model_context_window) setContext(s, { used: last, window: p.info.model_context_window })
      const limits = usage.codexWindows(p.rate_limits)
      if (limits.length) {
        usageState.codex = { limits, plan: p.rate_limits.plan_type || usageState.codex.plan, updatedAt: Date.now() }
        send('usage:update', usageState)
      }
    }
  } else if (obj.type === 'response_item' && p.type === 'message' && p.role === 'user') {
    const text = (p.content || []).filter(c => c.type === 'input_text').map(c => c.text).join('\n').trim()
    if (text && !text.startsWith('<')) s.lastPrompt = text.slice(0, 500)
  }
}

function pollCodex() {
  for (const s of sessions.values()) {
    if (s.kind !== 'codex') continue
    const c = s.codex
    if (!c.file) {
      if (s.exited) continue
      c.file = findRollout(s)
      if (!c.file) continue
      claimed.add(c.file)
      const convId = c.file.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)?.[1]
      if (convId && convId !== s.convId) {
        s.convId = convId
        saveTabs()
      }
    }
    let size
    try { size = fs.statSync(c.file).size } catch { continue }
    if (size <= c.offset) continue
    const fd = fs.openSync(c.file, 'r')
    const buf = Buffer.alloc(size - c.offset)
    fs.readSync(fd, buf, 0, buf.length, c.offset)
    fs.closeSync(fd)
    c.offset = size
    const lines = (c.partial + buf.toString('utf8')).split('\n')
    c.partial = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try { handleCodexLine(s, JSON.parse(line)) } catch {}
    }
    send('session:update', publicSession(s))
  }
}

// ---------- usage polling ----------

let claudeTimer = null
async function refreshClaude() {
  clearTimeout(claudeTimer)
  const r = await usage.fetchClaude()
  usageState.claude = r.limits ? { ...r, updatedAt: Date.now() } : { ...usageState.claude, error: r.error, loading: false }
  send('usage:update', usageState)
  claudeTimer = setTimeout(refreshClaude, r.retryLater ? 300000 : 90000)
}
let codexTimer = null
async function refreshCodex() {
  clearTimeout(codexTimer)
  const r = await usage.fetchCodex()
  usageState.codex = r.limits ? { ...r, updatedAt: Date.now() } : { ...usageState.codex, error: r.error, loading: false }
  send('usage:update', usageState)
  codexTimer = setTimeout(refreshCodex, 120000)
}

// ---------- IPC ----------

ipcMain.handle('app:init', () => {
  restoring = !sessions.size && !!config.tabs?.length
  return {
    config,
    usage: usageState,
    updates: updateState,
    sessions: [...sessions.values()].map(publicSession),
    version: app.getVersion(),
    appUpdate,
  }
})
// ---------- app self-update ----------

// From a git checkout: pull and relaunch. Installed: electron-updater downloads
// the new installer from GitHub Releases in the background; the button then
// installs it now, otherwise it installs when the app quits.
let appUpdate = { state: 'off' }
const autoUpdater = app.isPackaged ? require('electron-updater').autoUpdater : null
if (autoUpdater) {
  autoUpdater.on('update-downloaded', info => {
    appUpdate = { state: 'available', version: info.version, ready: true }
    send('app-update:state', appUpdate)
  })
  autoUpdater.on('error', e => console.error('auto-update:', e?.message || e))
}
async function checkAppUpdate() {
  if (appUpdate.state === 'updating') return
  if (autoUpdater) return autoUpdater.checkForUpdates().catch(() => {})
  appUpdate = await selfUpdate.check()
  send('app-update:state', appUpdate)
}
ipcMain.handle('app-update:run', async () => {
  const working = [...sessions.values()].filter(s => s.status === 'working' && !s.exited)
  if (working.length) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['更新並重開', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: `有 ${working.length} 個對話正在工作`,
      detail: '更新後 App 會重開，進行中的工作會被中斷；頁籤與對話會在重開後自動接回。',
    })
    if (response !== 0) return {}
  }
  if (autoUpdater) {
    // Silent install into the same folder, then start the app again.
    autoUpdater.quitAndInstall(true, true)
    return {}
  }
  const prev = appUpdate
  appUpdate = { ...prev, state: 'updating' }
  send('app-update:state', appUpdate)
  const r = await selfUpdate.apply()
  if (r.error) {
    appUpdate = prev
    send('app-update:state', appUpdate)
    return { error: r.error }
  }
  selfUpdate.relaunch(app, r.needInstall)
  return {}
})

ipcMain.on('tabs:restored', () => {
  restoring = false
  saveTabs()
})
ipcMain.handle('session:create', async (_e, kind, cwd, cols, rows, restore) => {
  // Don't start a CLI while its update may be replacing the executable.
  await updating[kind]
  const spawnReq = restore?.spawnReq
  if (spawnReq && !spawns.has(spawnReq)) return { error: 'AI 開啟對話的請求已取消或逾時' }
  try {
    const session = createSession(kind, cwd || config.cwd, cols, rows, restore || {})
    if (spawnReq) spawns.get(spawnReq)({ id: session.id })
    return { session }
  } catch (e) {
    if (spawnReq) spawns.get(spawnReq)({ error: e.message })
    return { error: e.message }
  }
})
ipcMain.on('session:input', (_e, id, data) => {
  const s = sessions.get(id)
  if (!s?.pty) return
  s.inputAt = Date.now()
  // A human submitting something refills this session's collaboration budget.
  if (data.includes('\r')) s.asksThisTurn = 0
  s.pty.write(data)
  if (s.kind === 'codex' && s.awaitingApproval && s.status === 'waiting') {
    s.awaitingApproval = false
    s.outBuf = ''
    setStatus(s, 'working', '')
  }
})
ipcMain.on('session:resize', (_e, id, cols, rows) => {
  const s = sessions.get(id)
  if (s?.pty && cols > 0 && rows > 0) try { s.pty.resize(cols, rows) } catch {}
})
ipcMain.on('session:rename', (_e, id, name) => {
  const s = sessions.get(id)
  if (!s) return
  s.customTitle = String(name || '').trim().slice(0, 80) || null
  send('session:update', publicSession(s))
  saveTabs()
})
// Clicking a finished card marks it seen: back to waiting, with no notification.
ipcMain.on('session:ack', (_e, id) => {
  const s = sessions.get(id)
  if (!s || s.status !== 'done') return
  s.status = 'waiting'
  s.detail = ''
  s.since = Date.now()
  send('session:update', publicSession(s))
})
ipcMain.on('session:active', (_e, id) => {
  activeId = id
  saveTabs()
})
ipcMain.on('session:close', (_e, id) => {
  const s = sessions.get(id)
  if (!s) return
  try { s.pty?.kill() } catch {}
  sessions.delete(id)
  for (const f of [`${id}.json`, `${id}-settings.json`])
    try { fs.rmSync(path.join(app.getPath('userData'), 'mcp', f), { force: true }) } catch {}
  send('session:removed', id)
  saveTabs()
})
function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url)
}
ipcMain.on('link:open', (_e, url) => openExternal(String(url)))
ipcMain.handle('dir:pick', async () => {
  const r = await dialog.showOpenDialog(win, { defaultPath: config.cwd, properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths[0]) return null
  rememberDir(r.filePaths[0])
  return config
})
ipcMain.handle('dir:set', (_e, dir) => {
  if (fs.existsSync(dir)) rememberDir(dir)
  return config
})
ipcMain.on('usage:refresh', () => {
  refreshClaude()
  refreshCodex()
})
ipcMain.handle('git:read', (_e, cwd) => (cwd && fs.existsSync(cwd) ? readRepo(cwd) : { isRepo: false }))
ipcMain.handle('git:working-diff', (_e, cwd, rel) => workingDiff(cwd, rel))
ipcMain.handle('git:show', (_e, cwd, hash) => showCommit(cwd, hash))
ipcMain.handle('git:commit', (_e, cwd, message, paths) => gitOps.commit(cwd, String(message || ''), Array.isArray(paths) ? paths : []))
ipcMain.handle('git:pull', (_e, cwd) => gitOps.pull(cwd))
ipcMain.handle('git:push', (_e, cwd) => gitOps.push(cwd))
ipcMain.on('session:spawned', (_e, req, result) => spawns.get(req)?.(result || { error: '開啟失敗' }))
ipcMain.handle('collab:set', (_e, next) => collab.setLimits(next || {}))
ipcMain.on('collab:stop', () => collab.stopAll())
ipcMain.handle('clipboard:read', () => clipboard.readText())
ipcMain.handle('menu:terminal', (_e, hasSelection) => new Promise(resolve => {
  let picked = null
  const item = (label, action, enabled = true, accelerator) => ({ label, accelerator, enabled, click: () => (picked = action) })
  Menu.buildFromTemplate([
    item('複製', 'copy', hasSelection, 'Ctrl+C'),
    item('貼上', 'paste', true, 'Ctrl+V'),
    { type: 'separator' },
    item('全選', 'selectAll'),
    item('清除畫面', 'clear'),
  ]).popup({ window: win, callback: () => setImmediate(() => resolve(picked)) })
}))
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(text))

// ---------- app ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 960,
    minHeight: 560,
    backgroundColor: '#0f1115',
    title: 'AI Tools Terminal',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  // Web links open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return
    e.preventDefault()
    openExternal(url)
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.on('focus', () => win.flashFrame(false))
  win.on('closed', () => (win = null))
}

app.whenReady().then(async () => {
  // Windows takes a notification's icon from the Start menu shortcut with this
  // ID; the installer creates its shortcuts with the build appId.
  app.setAppUserModelId(app.isPackaged ? 'com.gkkc6.ai-tools-terminal' : 'AI Tools Terminal')
  hookPort = await startHookServer()
  createWindow()
  startUpdates()
  refreshClaude()
  refreshCodex()
  setInterval(pollCodex, 1000)
  if (autoUpdater || selfUpdate.supported(app.isPackaged)) {
    setTimeout(checkAppUpdate, 5000)
    setInterval(checkAppUpdate, 30 * 60000)
  }
})

app.on('before-quit', () => {
  for (const s of sessions.values()) try { s.pty?.kill() } catch {}
})
app.on('window-all-closed', () => app.quit())
