// Updates the Claude Code and Codex CLIs (`<cli> update`) and reports the
// version before and after.
const { execFile, spawn } = require('child_process')

const UPDATE_TIMEOUT_MS = 5 * 60 * 1000

function version(exe) {
  return new Promise(resolve => {
    execFile(exe, ['--version'], { windowsHide: true, timeout: 20000, encoding: 'utf8' }, (_err, stdout) => {
      resolve((stdout || '').match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] || null)
    })
  })
}

function runUpdate(exe) {
  return new Promise(resolve => {
    let out = ''
    const p = spawn(exe, ['update'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_NON_INTERACTIVE: '1', CI: '1' },
    })
    const timer = setTimeout(() => {
      try { p.kill() } catch {}
      resolve({ code: -1, out: out + '\n（更新逾時）' })
    }, UPDATE_TIMEOUT_MS)
    p.stdout.on('data', d => (out += d))
    p.stderr.on('data', d => (out += d))
    p.on('error', e => {
      clearTimeout(timer)
      resolve({ code: -1, out: e.message })
    })
    p.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

/** Updates one CLI; `exe` is its resolved path or null when not installed. */
async function updateCli(exe) {
  if (!exe) return { state: 'missing' }
  const before = await version(exe)
  const { code, out } = await runUpdate(exe)
  const after = await version(exe)
  if (code !== 0 && before === after)
    return { state: 'error', before, after, message: out.trim().split('\n').pop()?.slice(0, 200) || `結束代碼 ${code}` }
  return { state: before && after && before !== after ? 'updated' : 'latest', before, after }
}

module.exports = { updateCli }
