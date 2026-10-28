// Follow-up items the AI suggested but the user didn't take on yet, kept per
// folder. Sessions add and finish them through the aitt MCP tools; the user
// checks them off in the side panel. Finished items stay in the file marked
// done; the panel lists the last week's under "done" (where they can be
// restored), but they are never returned to the models again.

const fs = require('fs')
const path = require('path')

const TOOLS = ['add_todo', 'list_todos', 'complete_todo']

const ok = text => ({ text })
const fail = text => ({ text, isError: true })
const folderKey = dir => path.resolve(dir).toLowerCase()
const isDir = dir => { try { return fs.statSync(dir).isDirectory() } catch { return false } }

function createTodos({ file, sessions, send }) {
  let items = []
  try { items = JSON.parse(fs.readFileSync(file, 'utf8')).items || [] } catch {}
  let seq = items.reduce((n, t) => Math.max(n, Number(String(t.id).slice(1)) || 0), 0)

  const open = () => items.filter(t => !t.done)
  // What the panel shows: open items, plus the last few finished for its "done" section.
  const RECENT_MS = 7 * 86400000
  const visible = () => [
    ...open(),
    ...items.filter(t => t.done && Date.now() - t.doneAt < RECENT_MS).sort((a, b) => b.doneAt - a.doneAt).slice(0, 30),
  ]
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ items }, null, 2))
    send('todos:update', visible())
  }

  function finish(id, how) {
    const t = items.find(x => x.id === id && !x.done)
    if (!t) return null
    t.done = how
    t.doneAt = Date.now()
    save()
    return t
  }

  function call(fromId, tool, args) {
    const s = sessions.get(fromId)
    if (!s) return fail('找不到呼叫端對話。')
    // An item belongs to the project it is about, which may not be the caller's folder.
    let cwd = s.cwd
    if (args.folder) {
      cwd = path.resolve(String(args.folder).trim())
      if (!path.isAbsolute(String(args.folder).trim()) || !isDir(cwd)) return fail(`folder 必須是存在的資料夾絕對路徑：${args.folder}`)
    }
    const key = folderKey(cwd)
    const here = () => open().filter(t => folderKey(t.cwd) === key)
    if (tool === 'add_todo') {
      const title = String(args.title || '').trim()
      if (!title) return fail('title 不可為空。')
      const dup = here().find(t => t.title === title)
      if (dup) return ok(`已存在：${dup.id}`)
      const from = s.customTitle || s.autoTitle || s.folder
      const t = { id: `t${++seq}`, cwd, title, detail: String(args.detail || '').trim(), from, createdAt: Date.now(), done: false }
      items.push(t)
      save()
      return ok(`已記下 ${t.id}${key === folderKey(s.cwd) ? '' : `（${path.basename(cwd)}）`}`)
    }
    if (tool === 'list_todos') {
      const list = here()
      return ok(list.length ? list.map(t => `- ${t.id}｜${t.title}${t.detail ? `｜${t.detail}` : ''}`).join('\n') : '這個資料夾沒有待辦。')
    }
    if (tool === 'complete_todo') {
      const id = String(args.id || '').trim()
      // Ids are unique across folders, so an item filed under another project can be finished too.
      if (!open().some(t => t.id === id)) return fail('找不到該待辦（可能已完成或被使用者移除）。')
      finish(id, 'ai')
      return ok(`已完成 ${id}`)
    }
    return fail(`未知的工具：${tool}`)
  }

  return {
    has: tool => TOOLS.includes(tool),
    call,
    visible,
    dismiss: id => finish(id, 'user'),
    restore(id) {
      const t = items.find(x => x.id === id && x.done)
      if (!t) return
      t.done = false
      delete t.doneAt
      save()
    },
  }
}

module.exports = { createTodos, TODO_TOOLS: TOOLS }
