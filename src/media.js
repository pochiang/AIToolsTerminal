// Now playing in the top bar: a long-lived Windows PowerShell helper
// (media.ps1) answers one JSON line per command; we poll it and relay changes.
const { spawn, execFile } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// -EncodedCommand also works from inside the asar and under any execution policy.
const SCRIPT = Buffer.from(fs.readFileSync(path.join(__dirname, 'media.ps1'), 'utf8'), 'utf16le').toString('base64')
const COVER_SRC = fs.readFileSync(path.join(__dirname, 'media-cover.cs'), 'utf8')
const POLL_MS = 1500

/** Compiles media-cover.cs once per version of it; resolves to the DLL path, or null. */
function buildCover(dir) {
  const hash = crypto.createHash('sha1').update(COVER_SRC).digest('hex').slice(0, 10)
  const dll = path.join(dir, `media-cover-${hash}.dll`)
  if (fs.existsSync(dll)) return Promise.resolve(dll)
  const windir = process.env.WINDIR || 'C:\\Windows'
  const net = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  const md = path.join(windir, 'System32', 'WinMetadata')
  const src = path.join(dir, 'media-cover.cs')
  return new Promise(resolve => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(src, COVER_SRC)
    } catch { return resolve(null) }
    const refs = [path.join(net, 'System.Runtime.dll'), ...['Foundation', 'Media', 'Storage'].map(n => path.join(md, `Windows.${n}.winmd`))]
    execFile(path.join(net, 'csc.exe'), ['-nologo', '-target:library', `-out:${dll}`, ...refs.map(r => `-r:${r}`), src], { windowsHide: true }, err => {
      if (err) console.error('media cover build failed:', err.message)
      resolve(!err && fs.existsSync(dll) ? dll : null)
    })
  })
}

function createMedia(onChange, { cacheDir }) {
  const cover = buildCover(cacheDir)
  let proc = null
  let buf = ''
  let waiting = [] // resolvers, in the order commands were sent
  let last = ''
  let track = { key: null, cover: null }
  let failures = 0
  let pausedUntil = 0

  async function start() {
    const dll = await cover
    proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, AITT_COVER_DLL: dll || '' },
    })
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        let msg = null
        try { msg = JSON.parse(line) } catch {}
        waiting.shift()?.(msg)
      }
    })
    proc.on('exit', () => {
      proc = null
      buf = ''
      for (const r of waiting) r(null)
      waiting = []
    })
    proc.on('error', () => {})
  }

  let starting = null
  async function ask(command) {
    if (!proc) await (starting ||= start().finally(() => (starting = null)))
    return new Promise(resolve => {
      waiting.push(resolve)
      proc.stdin.write(command + '\n')
    })
  }

  async function run(command) {
    const msg = await ask(command)
    if (!msg || msg.error) {
      // A broken helper (no media API, PowerShell missing) stays quiet; retry in a minute.
      if (msg?.error) console.error('media:', msg.error)
      if (++failures >= 3) {
        failures = 0
        pausedUntil = Date.now() + 60000
        proc?.kill()
      }
      return
    }
    failures = 0
    if (msg.none || !msg.title) return emit(null)
    // The helper sends the cover once per track; remember it for that track.
    const key = `${msg.app}|${msg.title}|${msg.artist}`
    if (key !== track.key) track = { key, cover: null }
    if (msg.cover) track.cover = msg.cover
    // Fixed key order: the helper's hashtables serialize in any order.
    emit({
      app: msg.app, title: msg.title, artist: msg.artist, status: msg.status, canPrev: msg.canPrev, canNext: msg.canNext,
      cover: track.cover,
    })
  }

  function emit(state) {
    // Compare without the (large) cover itself; the track key covers its changes.
    const sig = state ? JSON.stringify({ ...state, cover: !!state.cover }) : 'null'
    if (sig === last) return
    last = sig
    onChange(state)
  }

  let polling = false
  setInterval(async () => {
    // Skip a tick while the previous poll is still out (a slow first start).
    if (polling || Date.now() < pausedUntil) return
    polling = true
    try { await run('poll') } finally { polling = false }
  }, POLL_MS)

  return {
    control: command => (['toggle', 'next', 'prev'].includes(command) ? run(command) : undefined),
  }
}

module.exports = { createMedia }
