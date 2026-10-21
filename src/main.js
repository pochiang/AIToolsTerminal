const { app, BrowserWindow, ipcMain, dialog, clipboard, Notification, Menu } = require('electron')
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
})

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
  const { pty: _p, codex: _c, outBuf: _o, oscTail: _t, ...rest } = s
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
      setStatus(s, 'working', 'Codex 正在處理')
    }
    const topic = topicFromTitle(m[1], s)
    if (topic && topic !== s.autoTitle) {
      s.autoTitle = topic
      send('session:update', publicSession(s))
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
    collab.onDone(s, detail === '已中斷')
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
    // The tool's top bar already shows quotas; drop the in-terminal usage band.
    enabledPlugins: { 'usage-bars@gkkc6-mods': false },
    permissions: { allow: ['mcp__aitt__list_sessions', 'mcp__aitt__ask_session'] },
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

function createSession(kind, cwd, cols, rows) {
  const exeName = kind === 'claude' ? 'claude' : 'codex'
  const exe = resolveExe(exeName)
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
  } else {
    const env = Object.entries(bridgeEnv).map(([k, v]) => `${k}="${v}"`).join(',')
    args = [
      '-c', `mcp_servers.aitt.command="${NODE_RUNTIME}"`,
      '-c', `mcp_servers.aitt.args=["${MCP_BRIDGE}"]`,
      '-c', `mcp_servers.aitt.env={${env}}`,
      '-c', `mcp_servers.aitt.tool_timeout_sec=${toolTimeoutSec}`,
      // The relay enforces its own limits; don't stop for approval on every call.
      '-c', 'mcp_servers.aitt.default_tools_approval_mode="approve"',
    ]
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
    autoTitle: null,
    customTitle: null,
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

  p.onData(data => {
    // Keep the mouse for selecting text: drop requests to capture it.
    data = data.replace(MOUSE_MODE_RE, '')
    send('pty:data', id, data)
    watchTitle(s, data)
    if (kind === 'codex') watchCodexApproval(s, data)
  })
  p.onExit(({ exitCode }) => {
    s.exited = true
    s.pty = null
    setStatus(s, 'done', `程序已結束（代碼 ${exitCode}）`)
  })
  rememberDir(cwd)
  return publicSession(s)
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
  switch (event) {
    case 'UserPromptSubmit':
      s.everWorked = true
      if (payload.prompt) s.lastPrompt = String(payload.prompt).slice(0, 500)
      setStatus(s, 'working', 'Claude 正在處理')
      break
    case 'PostToolUse':
      if (s.status === 'waiting') setStatus(s, 'working', 'Claude 正在處理')
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

function handleCodexLine(s, obj) {
  const p = obj.payload || {}
  if (obj.type === 'event_msg') {
    if (p.type === 'task_started') {
      s.everWorked = true
      s.awaitingApproval = false
      setStatus(s, 'working', 'Codex 正在處理')
    } else if (p.type === 'task_complete') {
      if (p.last_agent_message) s.lastReply = String(p.last_agent_message)
      setStatus(s, 'done', '')
    } else if (p.type === 'turn_aborted') {
      setStatus(s, 'done', '已中斷')
    } else if (p.type === 'token_count') {
      const total = p.info?.total_token_usage?.total_tokens
      if (total) s.tokens = total
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

ipcMain.handle('app:init', () => ({
  config,
  usage: usageState,
  updates: updateState,
  sessions: [...sessions.values()].map(publicSession),
}))
ipcMain.handle('session:create', async (_e, kind, cwd, cols, rows) => {
  // Don't start a CLI while its update may be replacing the executable.
  await updating[kind]
  try {
    return { session: createSession(kind, cwd || config.cwd, cols, rows) }
  } catch (e) {
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
    setStatus(s, 'working', 'Codex 正在處理')
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
})
ipcMain.on('session:active', (_e, id) => {
  activeId = id
})
ipcMain.on('session:close', (_e, id) => {
  const s = sessions.get(id)
  if (!s) return
  try { s.pty?.kill() } catch {}
  sessions.delete(id)
  for (const f of [`${id}.json`, `${id}-settings.json`])
    try { fs.rmSync(path.join(app.getPath('userData'), 'mcp', f), { force: true }) } catch {}
  send('session:removed', id)
})
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
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.on('focus', () => win.flashFrame(false))
  win.on('closed', () => (win = null))
}

app.whenReady().then(async () => {
  app.setAppUserModelId('AI Tools Terminal')
  hookPort = await startHookServer()
  createWindow()
  startUpdates()
  refreshClaude()
  refreshCodex()
  setInterval(pollCodex, 1000)
})

app.on('before-quit', () => {
  for (const s of sessions.values()) try { s.pty?.kill() } catch {}
})
app.on('window-all-closed', () => app.quit())
