// Follow-up items the AI suggested but the user didn't take on yet, kept per
// folder. Sessions add and finish them through the aitt MCP tools; the user
// dismisses them with ✕ in the side panel. Finished or dismissed items stay in
// the file marked done, but are never shown or returned to the models again.

const fs = require('fs')
const path = require('path')

const TOOLS = ['add_todo', 'list_todos', 'complete_todo']

const ok = text => ({ text })
const fail = text => ({ text, isError: true })
const folderKey = dir => path.resolve(dir).toLowerCase()

function createTodos({ file, sessions, send }) {
  let items = []
  try { items = JSON.parse(fs.readFileSync(file, 'utf8')).items || [] } catch {}
  let seq = items.reduce((n, t) => Math.max(n, Number(String(t.id).slice(1)) || 0), 0)

  const open = () => items.filter(t => !t.done)
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ items }, null, 2))
    send('todos:update', open())
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
    const key = folderKey(s.cwd)
    const here = () => open().filter(t => folderKey(t.cwd) === key)
    if (tool === 'add_todo') {
      const title = String(args.title || '').trim()
      if (!title) return fail('title 不可為空。')
      const dup = here().find(t => t.title === title)
      if (dup) return ok(`已存在：${dup.id}`)
      const t = { id: `t${++seq}`, cwd: s.cwd, title, detail: String(args.detail || '').trim(), createdAt: Date.now(), done: false }
      items.push(t)
      save()
      return ok(`已記下 ${t.id}`)
    }
    if (tool === 'list_todos') {
      const list = here()
      return ok(list.length ? list.map(t => `- ${t.id}｜${t.title}${t.detail ? `｜${t.detail}` : ''}`).join('\n') : '這個資料夾沒有待辦。')
    }
    if (tool === 'complete_todo') {
      const id = String(args.id || '').trim()
      if (!here().some(t => t.id === id)) return fail('找不到該待辦（可能已完成或被使用者移除）。')
      finish(id, 'ai')
      return ok(`已完成 ${id}`)
    }
    return fail(`未知的工具：${tool}`)
  }

  return {
    has: tool => TOOLS.includes(tool),
    call,
    open,
    dismiss: id => finish(id, 'user'),
  }
}

module.exports = { createTodos, TODO_TOOLS: TOOLS }
