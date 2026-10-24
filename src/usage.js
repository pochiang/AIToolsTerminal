// Rate-limit usage for Claude (OAuth usage endpoint) and Codex (app-server
// JSON-RPC, falling back to the newest session log).
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const CLAUDE_LIMITS = [
  ['five_hour', '5 小時'],
  ['seven_day', '每週'],
  ['seven_day_opus', '每週 Opus'],
  ['seven_day_sonnet', '每週 Sonnet'],
]

async function fetchClaude() {
  let cred
  try {
    cred = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')).claudeAiOauth
  } catch {
    return { error: 'Claude 尚未登入', needsLogin: true }
  }
  if (!cred?.accessToken) return { error: 'Claude 尚未登入', needsLogin: true }
  let res
  try {
    res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15000),
    })
  } catch (e) {
    return { error: `連線失敗：${e.message}` }
  }
  if (res.status === 401) return { error: '權杖已過期，開啟一次 Claude Code 即會自動更新' }
  if (res.status === 429) return { error: '查詢太頻繁，稍後自動重試', retryLater: true }
  if (!res.ok) return { error: `Claude 回應 ${res.status}` }
  const json = await res.json()
  const limits = []
  for (const [key, label] of CLAUDE_LIMITS) {
    const w = json[key]
    if (!w || typeof w.utilization !== 'number') continue
    limits.push({ key, label, percent: w.utilization, resetsAt: w.resets_at || null })
  }
  return { limits, plan: cred.subscriptionType || null }
}

function codexPath() {
  return new Promise(resolve => {
    const p = spawn('where.exe', ['codex'], { windowsHide: true })
    let out = ''
    p.stdout.on('data', d => (out += d))
    p.on('close', () => resolve(out.split(/\r?\n/).map(s => s.trim()).find(Boolean) || null))
    p.on('error', () => resolve(null))
  })
}

function codexWindows(rl) {
  const limits = []
  for (const w of [rl?.primary, rl?.secondary]) {
    if (!w) continue
    const percent = w.usedPercent ?? w.used_percent
    const mins = w.windowDurationMins ?? w.window_minutes
    const resets = w.resetsAt ?? w.resets_at
    if (typeof percent !== 'number') continue
    const label = mins === 300 ? '5 小時' : mins === 10080 ? '每週' : `${Math.round(mins / 60)} 小時`
    limits.push({ key: String(mins), label, percent, resetsAt: resets ? new Date(resets * 1000).toISOString() : null })
  }
  return limits
}

async function fetchCodexAppServer() {
  const exe = await codexPath()
  if (!exe) return { error: '找不到 codex 指令' }
  return new Promise(resolve => {
    const p = spawn(exe, ['app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    let done = false
    const finish = r => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { p.kill() } catch {}
      resolve(r)
    }
    const timer = setTimeout(() => finish({ error: 'Codex 沒有回應' }), 15000)
    p.on('error', e => finish({ error: e.message }))
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith('{')) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id !== 1) continue
        if (msg.error) return finish({ error: `Codex：${msg.error.message || '錯誤'}` })
        const limits = codexWindows(msg.result?.rateLimits)
        finish(limits.length ? { limits, plan: msg.result?.rateLimits?.planType || null } : { error: 'Codex 未提供額度（需 ChatGPT 登入）' })
      }
    })
    const w = s => p.stdin.write(JSON.stringify(s) + '\n')
    w({ method: 'initialize', id: 0, params: { clientInfo: { name: 'ai_tools_terminal', title: 'AI Tools Terminal', version: '0.1.0' } } })
    w({ method: 'initialized' })
    w({ method: 'account/rateLimits/read', id: 1 })
  })
}

/** Newest rate_limits recorded in any Codex session log. */
function codexFromLogs() {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  let newest = null
  const walk = (dir, depth) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory() && depth < 3) walk(p, depth + 1)
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const m = fs.statSync(p).mtimeMs
        if (!newest || m > newest.m) newest = { p, m }
      }
    }
  }
  walk(root, 0)
  if (!newest) return { error: '沒有 Codex 使用紀錄' }
  const text = tail(newest.p, 512 * 1024)
  const lines = text.split('\n').reverse()
  for (const line of lines) {
    if (!line.includes('"rate_limits"')) continue
    try {
      const rl = JSON.parse(line).payload?.rate_limits
      const limits = codexWindows(rl)
      if (limits.length) return { limits, plan: rl.plan_type || null, stale: true }
    } catch {}
  }
  return { error: '沒有 Codex 額度紀錄' }
}

function tail(file, bytes) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** `codex login status` exits non-zero when nobody is logged in. */
async function codexLoggedIn() {
  const exe = await codexPath()
  if (!exe) return true
  return new Promise(resolve => {
    const p = spawn(exe, ['login', 'status'], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => { try { p.kill() } catch {} resolve(true) }, 15000)
    p.on('close', code => { clearTimeout(timer); resolve(code === 0) })
    p.on('error', () => { clearTimeout(timer); resolve(true) })
  })
}

async function fetchCodex() {
  const live = await fetchCodexAppServer()
  if (live.limits) return live
  // Logged out, the old session logs would show stale limits; ask to log in instead.
  if (!(await codexLoggedIn())) return { error: 'Codex 尚未登入', needsLogin: true }
  const logged = codexFromLogs()
  return logged.limits ? logged : live
}

module.exports = { fetchClaude, fetchCodex, codexWindows, tail }
