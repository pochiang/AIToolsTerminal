// Reads a repository's state for the Git panel: branch, uncommitted changes,
// recent commits (with parents, for the graph), and diffs for the viewer.
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const MAX_COMMITS = 300
const MAX_CHANGES = 300
const MAX_DIFF = 1.5 * 1024 * 1024
const MAX_FILE = 256 * 1024

function git(cwd, args, input) {
  return new Promise(resolve => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args],
      { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => resolve(err && !stdout ? null : stdout),
    )
    if (input !== undefined) child.stdin.end(input)
  })
}

/** Paths matching .gitignore, including files that are tracked anyway. */
async function ignoredPaths(cwd, paths) {
  if (!paths.length) return new Set()
  const out = await git(cwd, ['check-ignore', '--no-index', '-z', '--stdin'], paths.join('\0') + '\0')
  return new Set((out || '').split('\0').filter(Boolean))
}

// The panel polls every few seconds and each git process has a real start-up
// cost on Windows, so remember what rarely changes: a folder's repository root,
// and the log until a ref moves.
const roots = new Map() // cwd -> repository root
const logs = new Map() // root -> { sig, out }

/** Changes whenever a ref moves (commit, checkout, branch, tag, fetch); null if unknown. */
function refsSignature(root) {
  const gitDir = path.join(root, '.git')
  try {
    // A worktree or submodule keeps its refs elsewhere; don't cache those.
    if (!fs.statSync(gitDir).isDirectory()) return null
  } catch { return null }
  const parts = []
  const add = file => {
    try {
      const st = fs.statSync(file)
      parts.push(file, st.mtimeMs, st.size)
    } catch {}
  }
  const walk = dir => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else add(p)
    }
  }
  for (const f of ['HEAD', 'packed-refs', 'FETCH_HEAD', path.join('logs', 'HEAD')]) add(path.join(gitDir, f))
  walk(path.join(gitDir, 'refs'))
  return parts.join('|')
}

async function readRepo(cwd) {
  let root = roots.get(cwd)
  if (!root || !fs.existsSync(path.join(root, '.git'))) {
    root = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim()
    if (!root) {
      roots.delete(cwd)
      return { isRepo: false }
    }
    roots.set(cwd, root)
  }

  const sig = refsSignature(root)
  const cached = logs.get(root)
  const [status, log] = await Promise.all([
    // -z keeps paths unquoted; run from the root so they are root-relative.
    git(root, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '-z']),
    sig && cached?.sig === sig
      ? cached.out
      : git(cwd, ['log', '--all', '--date-order', '--decorate=full', `-n${MAX_COMMITS}`, '--format=%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e']).then(out => {
        if (sig && out != null) logs.set(root, { sig, out })
        return out
      }),
  ])

  let branch = null
  let tracking = null
  let changes = []
  const entries = (status || '').split('\0')
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e) continue
    if (e.startsWith('## ')) {
      // `## main...origin/main [ahead 1, behind 2]` or `## No commits yet on main`
      let head = e.slice(3).replace(/^No commits yet on /, '')
      const bracket = head.match(/ \[(.+)\]$/)
      if (bracket) {
        tracking = bracket[1]
        head = head.slice(0, bracket.index)
      }
      branch = head.split('...')[0]
      continue
    }
    const code = e.slice(0, 2)
    const change = { code, path: e.slice(3) }
    // Renames and copies are followed by their source path.
    if (code[0] === 'R' || code[0] === 'C') change.from = entries[++i]
    changes.push(change)
  }
  const ignored = await ignoredPaths(root, changes.map(c => c.path))
  changes = changes.filter(c => !ignored.has(c.path))
  const totalChanges = changes.length
  changes = changes.slice(0, MAX_CHANGES)

  const commits = (log || '')
    .split('\x1e')
    .map(r => r.replace(/^\s+/, ''))
    .filter(Boolean)
    .map(r => {
      const [hash, parents, refs, author, time, subject] = r.split('\x1f')
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        author,
        time: Number(time) * 1000,
        subject,
      }
    })

  return { isRepo: true, root, branch, tracking, changes, totalChanges, commits }
}

const cap = text => (text.length > MAX_DIFF ? { patch: text.slice(0, MAX_DIFF), truncated: true } : { patch: text, truncated: false })

/** An untracked file as an all-added patch. */
function untrackedPatch(root, rel) {
  const file = path.join(root, rel)
  let buf
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return ''
    buf = Buffer.alloc(Math.min(st.size, MAX_FILE))
    const fd = fs.openSync(file, 'r')
    fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const header = `diff --git a/${rel} b/${rel}\nnew file\n--- /dev/null\n+++ b/${rel}\n`
    if (buf.includes(0)) return `${header}Binary file\n`
    const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    const more = st.size > MAX_FILE ? '\n+…（檔案過大，只顯示前 256 KB）' : ''
    return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map(l => '+' + l).join('\n')}${more}\n`
  } catch {
    return ''
  }
}

async function hasHead(root) {
  return !!(await git(root, ['rev-parse', '--verify', '-q', 'HEAD']))
}

/** Working-tree diff against HEAD: one file, or everything when `rel` is omitted. */
async function workingDiff(cwd, rel) {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim()
  if (!root) return { error: '不是 git 儲存庫' }
  const base = (await hasHead(root)) ? ['diff', 'HEAD', '-M'] : ['diff', '--cached', '-M']
  const repo = await readRepo(root)
  const targets = rel ? repo.changes.filter(c => c.path === rel) : repo.changes
  const tracked = targets.filter(c => c.code !== '??').flatMap(c => (c.from ? [c.from, c.path] : [c.path]))
  let patch = tracked.length ? (await git(root, [...base, '--', ...tracked])) || '' : ''
  for (const c of targets.filter(c => c.code === '??')) patch += untrackedPatch(root, c.path)
  return { ...cap(patch), files: targets.length }
}

async function showCommit(cwd, hash) {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) return { error: '無效的 commit' }
  const meta = await git(cwd, ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%B', hash])
  if (!meta) return { error: '找不到這個 commit' }
  const [full, parents, author, email, time, committer, body] = meta.split('\x1f')
  // Diff a merge against its first parent, like most history viewers.
  const patch = (await git(cwd, ['show', '--format=', '-m', '--first-parent', '-M', '--patch', hash])) || ''
  return {
    hash: full,
    parents: parents ? parents.trim().split(' ').filter(Boolean) : [],
    author,
    email,
    committer,
    time: Number(time) * 1000,
    message: (body || '').trim(),
    ...cap(patch),
  }
}

/** Runs a git command that may touch the network; never waits on a prompt. */
function run(cwd, args, timeout = 120000) {
  return new Promise(resolve => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.editor=true', ...args],
      { cwd, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim(), timedOut: !!err?.killed }),
    )
  })
}

const lastLine = text => text.split('\n').map(s => s.trim()).filter(Boolean).pop() || ''

async function rootOf(cwd) {
  return (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim() || null
}

/** Commits exactly `paths` (staging them first, so new and deleted files work too). */
async function commit(cwd, message, paths) {
  const root = await rootOf(cwd)
  if (!root) return { error: '不是 git 儲存庫' }
  if (!message.trim()) return { error: '請輸入提交訊息' }
  if (!paths.length) return { error: '沒有選擇要提交的檔案' }
  const add = await run(root, ['add', '-A', '--', ...paths])
  if (!add.ok) return { error: lastLine(add.out) || '加入暫存區失敗' }
  const r = await run(root, ['commit', '--only', '-m', message, '--', ...paths])
  if (!r.ok) return { error: lastLine(r.out) || '提交失敗' }
  const m = r.out.match(/^\[\S+(?: \([^)]*\))? ([0-9a-f]+)\] (.*)$/m)
  return { message: m ? `已提交 ${m[1]}：${m[2]}` : '提交完成' }
}

async function pull(cwd) {
  const root = await rootOf(cwd)
  if (!root) return { error: '不是 git 儲存庫' }
  const r = await run(root, ['pull', '--no-edit'])
  if (r.timedOut) return { error: '拉取逾時（可能在等待登入或網路問題）' }
  if (!r.ok) return { error: lastLine(r.out) || '拉取失敗' }
  if (/Already up to date|已經是最新/.test(r.out)) return { message: '已經是最新的' }
  const stat = r.out.split('\n').find(l => /files? changed/.test(l))
  return { message: `拉取完成${stat ? '：' + stat.trim() : ''}` }
}

async function push(cwd) {
  const root = await rootOf(cwd)
  if (!root) return { error: '不是 git 儲存庫' }
  let r = await run(root, ['push'])
  // First push of a new branch: publish it to the default remote.
  if (!r.ok && /no upstream branch|has no upstream/i.test(r.out)) {
    const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
    const remote = (await git(root, ['remote']))?.split('\n').map(s => s.trim()).filter(Boolean)
    if (!remote?.length) return { error: '這個儲存庫沒有設定遠端（remote）' }
    const target = remote.includes('origin') ? 'origin' : remote[0]
    r = await run(root, ['push', '-u', target, branch])
  }
  if (r.timedOut) return { error: '推送逾時（可能在等待登入或網路問題）' }
  if (!r.ok) return { error: lastLine(r.out) || '推送失敗' }
  return { message: /Everything up-to-date/.test(r.out) ? '沒有需要推送的提交' : '推送完成' }
}

module.exports = { readRepo, workingDiff, showCommit, commit, pull, push }
