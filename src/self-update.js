// Updates the app itself when it runs from a git checkout (start.cmd / npm start):
// fetch to see whether the tracked branch moved, then pull --ff-only and relaunch.
const { execFile, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

function git(args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 120000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || err?.message || '').trim() }),
    )
  })
}

/** An installed copy has no checkout to pull into. */
function supported(isPackaged) {
  return !isPackaged && fs.existsSync(path.join(ROOT, '.git'))
}

async function check() {
  const fetch = await git(['fetch', '--quiet'])
  if (!fetch.ok) return { state: 'error', error: `無法檢查更新：${fetch.err}` }
  const behind = await git(['rev-list', '--count', 'HEAD..@{u}'])
  if (!behind.ok) return { state: 'error', error: '目前分支沒有追蹤遠端分支' }
  const count = Number(behind.out) || 0
  if (!count) return { state: 'current' }
  let version = null
  try { version = JSON.parse((await git(['show', '@{u}:package.json'])).out).version } catch {}
  return { state: 'available', behind: count, version }
}

async function apply() {
  const dirty = await git(['status', '--porcelain', '--untracked-files=no'])
  if (dirty.out) return { error: '有尚未提交的改動，請先提交或還原再更新。' }
  const ahead = await git(['rev-list', '--count', '@{u}..HEAD'])
  if (Number(ahead.out) > 0) return { error: '有尚未推送的 commit，請先推送再更新。' }
  // Exit code 1 means the lockfile differs; any other failure, reinstall to be safe.
  const lock = await git(['diff', '--quiet', 'HEAD', '@{u}', '--', 'package-lock.json'])
  const pull = await git(['pull', '--ff-only', '--quiet'])
  if (!pull.ok) return { error: `更新失敗：${pull.err}` }
  return { needInstall: !lock.ok }
}

function relaunch(app, needInstall) {
  if (!needInstall) {
    app.relaunch()
    app.quit()
    return
  }
  // npm ci replaces node_modules, including the running electron.exe, so it
  // runs in its own console after this process has exited.
  const script = path.join(app.getPath('temp'), 'aitt-update.cmd')
  const pid = process.pid
  fs.writeFileSync(script, [
    '@echo off',
    'title AI Tools Terminal update',
    `cd /d "${ROOT}"`,
    ':wait',
    `tasklist /FI "PID eq ${pid}" | find "${pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
    'timeout /t 2 /nobreak >nul',
    'echo Installing packages (npm ci)...',
    'call npm ci',
    'if errorlevel 1 (echo. & echo npm ci failed. Fix the error above, run npm ci, then start.cmd. & pause & exit /b 1)',
    `start "" "${path.join(ROOT, 'start.cmd')}"`,
  ].join('\r\n'))
  spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore' }).unref()
  app.quit()
}

module.exports = { supported, check, apply, relaunch }
