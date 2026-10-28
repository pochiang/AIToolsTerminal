const api = window.aitt
const $ = id => document.getElementById(id)

const state = {
  config: { cwd: '', recentDirs: [] },
  usage: null,
  sessions: new Map(), // id -> public session
  terms: new Map(), // id -> { term, fit, el }
  pending: new Map(), // id -> data that arrived before the terminal was bound
  attention: new Set(),
  active: null,
  editing: null, // id of the session whose name is being edited
}

// Panel order, top to bottom.
const STATUS = {
  done: { label: '完成', order: 0 },
  working: { label: '工作中', order: 1 },
  waiting: { label: '等待中', order: 2 },
}
const KIND = {
  claude: { icon: '✻', name: 'Claude Code' },
  codex: { icon: '◎', name: 'Codex' },
  shell: { icon: '❯', name: 'Terminal' },
}

const THEME = {
  background: '#151821',
  foreground: '#e6e8ef',
  cursor: '#e6e8ef',
  selectionBackground: '#3a4a6b',
  black: '#1c2030', red: '#f7768e', green: '#7fd88e', yellow: '#f5c26b',
  blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5',
  brightBlack: '#5d6375', brightRed: '#ff8fa3', brightGreen: '#9ee6a9', brightYellow: '#ffd88a',
  brightBlue: '#9ab8ff', brightMagenta: '#cdb2ff', brightCyan: '#a4e0ff', brightWhite: '#ffffff',
}

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const base = p => (p || '').split(/[\\/]/).filter(Boolean).pop() || p

function untilReset(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 0) return '即將重置'
  const m = Math.ceil(ms / 60000)
  if (m < 60) return `${m} 分後重置`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 時 ${m % 60} 分後重置`
  return `${Math.floor(h / 24)} 天 ${h % 24} 時後重置`
}

let toastTimer
function toast(msg, kind = 'error') {
  const t = $('toast')
  t.textContent = msg
  t.className = `toast ${kind === 'info' ? 'info' : ''}`
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (t.hidden = true), 5000)
}

// ---------- usage ----------

function renderUsage() {
  const u = state.usage
  if (!u) return
  const group = (kind, name, d) => {
    let inner
    if (d.needsLogin) {
      inner = `<div class="usage-error">尚未登入</div><button class="login-btn ${kind}" data-login="${kind}">登入</button>`
    } else if (d.limits?.length) {
      inner = d.limits
        .map(l => {
          const pct = Math.round(l.percent)
          const cls = pct >= 85 ? 'high' : pct >= 60 ? 'mid' : ''
          return `<div class="meter">
            <div class="meter-head"><span>${esc(l.label)}</span><b>${pct}%</b></div>
            <div class="meter-bar"><div class="meter-fill ${cls}" style="width:${Math.min(100, pct)}%"></div></div>
            <div class="meter-reset">${esc(untilReset(l.resetsAt))}</div>
          </div>`
        })
        .join('')
      if (d.error) inner += `<div class="usage-error" title="${esc(d.error)}">⚠</div>`
      // Icons rather than text, so both cards keep the same fixed width.
      if (d.stale) inner += `<div class="usage-stale" title="取自最近紀錄，可能不是最新">⏱</div>`
    } else if (d.error) {
      inner = `<div class="usage-error">${esc(d.error)}</div>`
    } else {
      inner = `<div class="usage-error">讀取中…</div>`
    }
    return `<div class="usage-group ${kind}">
      <div class="usage-name"><span>${KIND[kind].icon} ${name}</span><small>${esc(d.plan || '')}</small>${versionLine(kind)}</div>
      ${inner}
    </div>`
  }
  $('usage').innerHTML = group('claude', 'Claude', u.claude) + group('codex', 'Codex', u.codex)
}

function versionLine(kind) {
  const u = state.updates?.[kind]
  if (!u) return ''
  const line = (cls, text, title = text) => `<span class="ver ${cls}" title="${esc(title)}">${esc(text)}</span>`
  switch (u.state) {
    case 'updating': return line('busy', '更新中…')
    case 'updated': return line('new', `已更新 v${u.after}`, `v${u.before} → v${u.after}`)
    case 'latest': return line('', `v${u.after || u.before}`, '已是最新版本')
    case 'error': return line('err', '更新失敗', u.message || '')
    case 'missing': return line('err', '未安裝')
    default: return ''
  }
}

// ---------- working directory ----------

function renderDir() {
  $('dir-label').textContent = state.config.cwd
  $('empty-dir').textContent = state.config.cwd
}
function toggleDirMenu(show) {
  const menu = $('dir-menu')
  menu.hidden = !show
  if (!show) return
  const recent = state.config.recentDirs
    .map(d => `<button data-dir="${esc(d)}" title="${esc(d)}">${esc(d)}</button>`)
    .join('')
  menu.innerHTML = `${recent}${recent ? '<div class="sep"></div>' : ''}<button class="pick" data-pick>📂 選擇其他資料夾…</button>`
}
$('dir-btn').addEventListener('click', e => {
  e.stopPropagation()
  toggleDirMenu($('dir-menu').hidden)
})
$('dir-menu').addEventListener('click', async e => {
  const b = e.target.closest('button')
  if (!b) return
  toggleDirMenu(false)
  const cfg = b.hasAttribute('data-pick') ? await api.pickDir() : await api.setDir(b.dataset.dir)
  if (cfg) {
    state.config = cfg
    renderDir()
    refreshGit()
  }
})
document.addEventListener('click', () => toggleDirMenu(false))


// ---------- terminals ----------

function makeTerm(holder) {
  const term = new Terminal({
    fontFamily: "'Cascadia Mono', Consolas, 'Microsoft JhengHei', monospace",
    fontSize: 14,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: THEME,
    // OSC 8 hyperlinks: open directly instead of xterm's confirm() prompt.
    linkHandler: { activate: (_e, uri) => api.openLink(uri) },
  })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  // Plain URLs in the output.
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => api.openLink(uri)))
  term.open(holder)
  try { fit.fit() } catch {}
  return { term, fit, gl: null }
}

// The visible terminal draws with WebGL: the DOM renderer is the main CPU cost
// while a session streams output. Hidden ones (visibility:hidden) would keep
// drawing and each hold a GPU context, so they go back to the DOM renderer.
// A lost context falls back to DOM too, and is retried on the next select.
function useGpu(t, on) {
  if (on === !!t.gl) return
  if (!on) {
    t.gl.dispose()
    t.gl = null
    return
  }
  try {
    const gl = new WebglAddon.WebglAddon()
    gl.onContextLoss(() => {
      gl.dispose()
      if (t.gl === gl) t.gl = null
    })
    t.term.loadAddon(gl)
    t.gl = gl
  } catch {}
}

// Clicking or typing in a finished session counts as having seen it.
function ack(id) {
  if (state.sessions.get(id)?.status === 'done') api.ack(id)
}

function bindTerm(id, t) {
  const { term } = t
  term.onData(d => {
    ack(id)
    api.input(id, d)
  })
  t.el.addEventListener('mousedown', () => ack(id))
  term.onResize(({ cols, rows }) => api.resize(id, cols, rows))
  const copy = () => {
    if (!term.hasSelection()) return false
    api.writeClipboard(term.getSelection())
    term.clearSelection()
    return true
  }
  // With no text on the clipboard, pass Ctrl+V through so the CLI can paste an image.
  const paste = () => api.readClipboard().then(text => (text ? term.paste(text) : api.input(id, '\x16')))

  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true
    const key = e.key.toLowerCase()
    // Ctrl+C copies only with a selection; otherwise it still interrupts.
    if (e.ctrlKey && !e.altKey && key === 'c' && (e.shiftKey || term.hasSelection())) {
      copy()
      e.preventDefault()
      return false
    }
    if ((e.ctrlKey && !e.altKey && key === 'v') || (e.shiftKey && e.key === 'Insert')) {
      e.preventDefault()
      paste()
      return false
    }
    if (e.ctrlKey && e.key === 'Insert') {
      copy()
      return false
    }
    // Shift+Enter inserts a newline in Claude Code / Codex instead of submitting.
    if (e.shiftKey && !e.ctrlKey && e.key === 'Enter') {
      api.input(id, '\x1b\r')
      return false
    }
    if (e.ctrlKey && e.key === 'Tab') return false
    return true
  })

  t.el.addEventListener('contextmenu', async e => {
    e.preventDefault()
    const action = await api.terminalMenu(term.hasSelection())
    if (action === 'copy') copy()
    else if (action === 'paste') paste()
    else if (action === 'selectAll') term.selectAll()
    else if (action === 'clear') term.clear()
    term.focus()
  })
  if (state.sessions.get(id)?.kind !== 'shell') watchTrustPrompt(id, term)
  state.terms.set(id, t)
  const queued = state.pending.get(id)
  if (queued) {
    term.write(queued.join(''))
    state.pending.delete(id)
  }
}

// The folder-trust menu each CLI shows in a new folder: Claude's
// `❯ No, exit / Yes, I trust this folder`, Codex's `› 1. Trust and continue`.
const TRUST_OPTION = /Yes, I trust this folder|Trust and continue|Yes, continue/
const SELECTED = /^\s*[❯›>]/

/** Answers the trust menu by moving the cursor onto the trust option and pressing Enter. */
function watchTrustPrompt(id, term) {
  const startedAt = Date.now()
  let keys = 0
  let timer = null
  const check = () => {
    timer = null
    const buf = term.buffer.active
    const lines = []
    for (let i = 0; i < term.rows; i++) lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '')
    const yes = lines.findIndex(l => TRUST_OPTION.test(l))
    if (yes < 0) return
    const selected = lines.findIndex(l => SELECTED.test(l))
    if (selected === yes) {
      api.input(id, '\r')
      sub.dispose()
    } else {
      api.input(id, selected >= 0 && selected > yes ? '\x1b[A' : '\x1b[B')
    }
    if (++keys >= 6) sub.dispose()
  }
  const sub = term.onWriteParsed(() => {
    if (Date.now() - startedAt > 60000) return sub.dispose()
    if (!timer) timer = setTimeout(check, 200)
  })
}

const DORMANT_TEXT = '這個對話還沒載入（重開時只先恢復目前的分頁），切到這裡就會開始恢復…'

// restore: a saved tab ({ cwd, convId, titles }) to reopen instead of a fresh session.
// background: open without switching to it (a session an AI opened).
async function launch(kind, restore, { background = false } = {}) {
  if (state.updates?.[kind]?.state === 'updating') toast(`${KIND[kind].name} 正在更新，完成後會自動開啟`, 'info')
  const holder = document.createElement('div')
  holder.className = background ? 'term' : 'term active'
  $('terms').appendChild(holder)
  if (!background) {
    for (const t of state.terms.values()) t.el.classList.remove('active')
    $('empty').hidden = true
  }
  const t = makeTerm(holder)
  const r = await api.createSession(kind, restore?.cwd || state.config.cwd, t.term.cols, t.term.rows, restore)
  if (r.error) {
    t.term.dispose()
    holder.remove()
    toast(r.error)
    if (!background) select(state.active)
    return
  }
  const s = r.session
  t.el = holder
  // An update may have arrived before the reply; keep the newer copy.
  if (!state.sessions.has(s.id)) state.sessions.set(s.id, s)
  bindTerm(s.id, t)
  if (s.dormant) t.term.write(`\r\n  \x1b[2m${DORMANT_TEXT}\x1b[0m`)
  if (background) render()
  else select(s.id)
  return s.id
}

function select(id) {
  if (!id || !state.sessions.has(id)) {
    id = [...state.sessions.keys()].pop() || null
  }
  state.active = id
  api.setActive(id)
  state.attention.delete(id)
  for (const [sid, t] of state.terms) {
    t.el.classList.toggle('active', sid === id)
    useGpu(t, sid === id)
  }
  $('empty').hidden = !!id
  const kind = id && state.sessions.get(id)?.kind
  if (kind) $('terms').dataset.kind = kind
  else delete $('terms').dataset.kind
  if (gitCwd() !== gitState.cwd) refreshGit()
  renderTodos()
  closeViewer()
  const t = id && state.terms.get(id)
  // Not in the frame callback: that doesn't run while the window is in the background.
  if (t && state.sessions.get(id)?.dormant) {
    try { t.fit.fit() } catch {}
    api.wake(id, t.term.cols, t.term.rows)
  }
  if (t) {
    requestAnimationFrame(() => {
      try { t.fit.fit() } catch {}
      t.term.focus()
    })
  }
  render()
}

function closeSession(id) {
  api.close(id)
}

function removeSession(id) {
  const t = state.terms.get(id)
  if (t) {
    t.term.dispose()
    t.el.remove()
  }
  state.terms.delete(id)
  state.sessions.delete(id)
  state.attention.delete(id)
  if (state.active === id) select(null)
  else render()
}

// ---------- tabs & status panel ----------

const closeArmed = new Map()

function renderTabs() {
  const html = [...state.sessions.values()]
    .map(s => {
      const armed = closeArmed.has(s.id)
      return `<div class="tab ${s.kind} ${s.id === state.active ? 'active' : ''} ${state.attention.has(s.id) ? 'attention' : ''} ${s.dormant ? 'dormant' : ''}" data-id="${s.id}" title="${esc(s.cwd)}${s.dormant ? '\n尚未載入，點擊恢復對話' : ''}">
        <span class="dot ${s.status} ${s.status === 'waiting' && s.detail && !s.dormant ? 'ask' : ''}"></span>
        <span class="kind ${s.kind}">${KIND[s.kind].icon}</span>
        ${s.aiOpened ? '<span class="ai-tag" title="由 AI 開啟">[AI]</span>' : ''}
        <span class="title" data-rename="${s.id}" title="${esc(s.title)}（雙擊重新命名）">${esc(s.title)}</span>
        <button class="close ${armed ? 'confirm' : ''}" data-close="${s.id}" title="關閉">${armed ? '確定關閉？' : '×'}</button>
      </div>`
    })
    .join('')
  // Status updates arrive constantly while a session works; replacing identical
  // markup would swap the element under the pointer mid-click.
  if (html !== lastTabsHtml) $('tabs').innerHTML = lastTabsHtml = html
}
let lastTabsHtml = ''

// Close on mousedown: a re-render between mousedown and mouseup (status changes)
// would otherwise swallow the click.
$('tabs').addEventListener('mousedown', e => {
  const close = e.button === 0 && e.target.closest('[data-close]')
  if (close) {
    e.preventDefault()
    const id = close.dataset.close
    const s = state.sessions.get(id)
    if (s.status === 'working' && !s.exited && !closeArmed.has(id)) {
      closeArmed.set(id, setTimeout(() => { closeArmed.delete(id); renderTabs() }, 3000))
      renderTabs()
      return
    }
    clearTimeout(closeArmed.get(id))
    closeArmed.delete(id)
    closeSession(id)
  }
})
$('tabs').addEventListener('click', e => {
  if (e.target.closest('[data-close]')) return
  const tab = e.target.closest('.tab')
  if (!tab) return
  ack(tab.dataset.id)
  select(tab.dataset.id)
})
$('tabs').addEventListener('auxclick', e => {
  const tab = e.target.closest('.tab')
  if (e.button === 1 && tab) closeSession(tab.dataset.id)
})

function renderStatus() {
  const order = s => STATUS[s.status]?.order ?? 2
  const list = [...state.sessions.values()].sort((a, b) => order(a) - order(b) || b.since - a.since)

  const box = $('status-groups')
  if (!list.length) {
    cards.clear()
    box.innerHTML = '<div class="group-empty">還沒有對話，從左邊開啟 Claude Code 或 Codex</div>'
    return
  }
  // Rebuild only the cards whose markup changed; untouched ones keep their DOM
  // (and their running animations).
  const els = list.map(s => {
    const html = card(s)
    const key = html.replace(/animation-delay:-[\d.]+s/g, '')
    let c = cards.get(s.id)
    if (!c || c.key !== key) {
      const tpl = document.createElement('template')
      tpl.innerHTML = html.trim()
      const el = tpl.content.firstElementChild
      if (c?.el.isConnected) c.el.replaceWith(el)
      c = { key, el }
      cards.set(s.id, c)
    }
    return c.el
  })
  for (const id of cards.keys()) if (!state.sessions.has(id)) cards.delete(id)
  const kids = box.children
  if (kids.length !== els.length || els.some((el, i) => kids[i] !== el)) box.replaceChildren(...els)
}
const cards = new Map() // session id -> { key: markup without wave phases, el }

const kTokens = n => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const WAVE = '<svg viewBox="0 0 80 10" preserveAspectRatio="none"><path d="M0 5 Q10 0 20 5 T40 5 T60 5 T80 5 V10 H0 Z"/></svg>'

// Cards are re-rendered on every update; start each wave at the phase it
// would be in by now so the water keeps flowing instead of jumping back.
const wavePhase = sec => `animation-delay:-${(Date.now() % (sec * 1000)) / 1000}s`

/** A vertical tank whose water level is how full the conversation's context is. */
function contextTank(ctx) {
  if (!ctx) return '<div class="tank" title="Context：尚無資料"><span class="tank-pct">—</span></div>'
  const { used, window } = ctx
  const pct = Math.min(100, Math.round((used / window) * 100))
  const cls = pct >= 85 ? 'high' : pct >= 60 ? 'mid' : ''
  return `<div class="tank ${cls}" title="Context：已使用 ${used.toLocaleString()} / ${window.toLocaleString()} tokens（${kTokens(used)}/${kTokens(window)}）">
    <div class="tank-water" style="height:${pct}%">
      <div class="tank-wave back" style="${wavePhase(3.2)}">${WAVE}</div>
      <div class="tank-wave" style="${wavePhase(2.2)}">${WAVE}</div>
    </div>
    <span class="tank-pct">${pct}%</span>
  </div>`
}

function card(s) {
  const meta = !s.context && s.tokens ? `<div class="card-meta">${s.tokens.toLocaleString()} tokens</div>` : ''
  const c = s.collab || {}
  // One line between title and folder keeps every card the same height.
  const collabLine = c.asking
    ? `<div class="card-collab">⇄ ${c.asking.queued ? '排隊等待' : '正在詢問'}「${esc(c.asking.title)}」</div>`
    : c.serving
      ? `<div class="card-collab">⇄ 正在回覆「${esc(c.serving.title)}」的請求</div>`
      : ''
  return `<div class="card ${s.status} ${s.kind} ${s.id === state.active ? 'selected' : ''} ${s.dormant ? 'dormant' : ''}" data-id="${s.id}" role="button" tabindex="0">
    <div class="card-main">
    <div class="card-head">
      <span class="kind ${s.kind}">${KIND[s.kind].icon}</span>
      ${s.aiOpened ? '<span class="ai-tag" title="由 AI 開啟">[AI]</span>' : ''}
      <span class="card-title" data-rename="${s.id}" title="${esc(s.title)}">${esc(s.title)}</span>
      <button class="card-edit" data-edit="${s.id}" title="重新命名">✎</button>
      <span class="badge ${s.status}"><span class="dot ${s.status}"></span>${STATUS[s.status]?.label ?? ''}</span>
    </div>
    ${collabLine || (s.detail ? `<div class="card-detail" title="${esc(s.detail)}">${esc(s.detail)}</div>` : meta || '<div class="card-meta"></div>')}
    <div class="card-dir" title="${esc(s.cwd)}"><bdi dir="ltr">${esc(s.cwd)}</bdi></div>
    </div>
    ${s.kind === 'shell' ? '' : contextTank(s.context)}
  </div>`
}

$('status-groups').addEventListener('click', e => {
  const edit = e.target.closest('[data-edit]')
  if (edit) {
    startRename(edit.dataset.edit, edit.parentElement.querySelector('.card-title'))
    return
  }
  const c = e.target.closest('.card')
  if (!c) return
  ack(c.dataset.id)
  select(c.dataset.id)
})

// ---------- todos ----------

// Follow-ups the AI recorded for the active session's folder. The circle checks
// one off (it plays out, then moves to the collapsed "done" section, where
// clicking the circle again restores it).
const dirKey = d => String(d || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
const CHECK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.4l2.6 2.6L12 5.4"/></svg>'
const TODO_OUT_MS = 520
const FOLDER_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3.1l1.5 1.6h5.4c.69 0 1.25.56 1.25 1.25v6.4c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z"/></svg>'
const todoUi = { completing: new Set(), seen: null, doneOpen: false }

const startOfToday = () => new Date().setHours(0, 0, 0, 0)

function todoItem(t) {
  const cls = [todoUi.completing.has(t.id) && 'completing', todoUi.seen && !todoUi.seen.has(t.id) && 'fresh'].filter(Boolean).join(' ')
  const meta = [t.from && `來自「${esc(t.from)}」`, t.createdAt && ago(t.createdAt)].filter(Boolean).join(' · ')
  return `<div class="todo ${cls}" data-id="${esc(t.id)}" title="${esc(t.detail || t.title)}\n\n點一下貼到目前對話的輸入框">
    <button class="todo-check" data-done="${esc(t.id)}" title="完成">${CHECK_SVG}</button>
    <div class="todo-body">
      <div class="todo-title">${esc(t.title)}</div>
      ${t.detail ? `<div class="todo-detail">${esc(t.detail)}</div>` : ''}
      ${meta ? `<div class="todo-meta">${meta}</div>` : ''}
    </div>
    <span class="todo-paste">↵</span>
  </div>`
}

function renderTodos() {
  const cwd = gitCwd()
  const hidden = !!state.config.todoHidden
  const panel = $('todo-panel')
  const here = cwd ? (state.todos || []).filter(t => dirKey(t.cwd) === dirKey(cwd)) : []
  const open = here.filter(t => !t.done)
  const done = here.filter(t => t.done)
  const today = done.filter(t => t.doneAt >= startOfToday()).length
  panel.classList.toggle('collapsed', hidden)
  if (state.todoWidth) panel.style.width = `${state.todoWidth[hidden ? 'closed' : 'open']}px`
  $('todo-count').textContent = open.length ? String(open.length) : ''
  $('todo-today').textContent = today ? `今天完成 ${today}` : ''
  $('todo-close').textContent = hidden ? '▸' : '◂'
  $('todo-close').title = hidden ? '展開待辦' : '收起'
  if (!cwd) {
    $('todo-list').innerHTML = '<div class="group-empty">選一個對話來看它資料夾的待辦</div>'
    return
  }
  const doneHtml = done.length
    ? `<div class="todo-done ${todoUi.doneOpen ? 'open' : ''}">
        <button class="todo-done-head" data-toggle-done><span class="chev">▸</span>已完成<span class="n">${done.length}</span></button>
        ${todoUi.doneOpen ? done.map(t => `<div class="todo is-done" title="${esc(t.title)}">
          <button class="todo-check" data-restore="${esc(t.id)}" title="移回待辦">${CHECK_SVG}</button>
          <div class="todo-body"><div class="todo-title">${esc(t.title)}</div>
          <div class="todo-meta">${t.done === 'ai' ? 'AI 完成' : '你勾選'} · ${ago(t.doneAt)}</div></div>
        </div>`).join('') : ''}
      </div>`
    : ''
  // Lists are per project folder; say which one so items never look mixed.
  const folder = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd
  $('todo-list').innerHTML =
    `<div class="todo-scope" title="${esc(cwd)}">${FOLDER_SVG}<span>${esc(folder)}</span></div>` +
    (open.length ? open.map(todoItem).join('') : `<div class="todo-empty">${CHECK_SVG}<span>${done.length ? '全部完成了' : '這個資料夾沒有待辦'}</span></div>`) +
    doneHtml
  // Only items that show up after the first draw get the "new" highlight.
  if (!todoUi.seen) todoUi.seen = new Set()
  for (const t of open) todoUi.seen.add(t.id)
}
$('todo-list').addEventListener('click', e => {
  const check = e.target.closest('[data-done]')
  if (check) {
    const id = check.dataset.done
    if (todoUi.completing.has(id)) return
    todoUi.completing.add(id)
    check.closest('.todo').classList.add('completing')
    // Let the check and strike play before the item leaves the list.
    setTimeout(() => api.dismissTodo(id), TODO_OUT_MS)
    return
  }
  const restore = e.target.closest('[data-restore]')
  if (restore) return api.restoreTodo(restore.dataset.restore)
  if (e.target.closest('[data-toggle-done]')) {
    todoUi.doneOpen = !todoUi.doneOpen
    return renderTodos()
  }
  // Clicking an item pastes its text into the active session's prompt, unsent.
  const item = e.target.closest('.todo:not(.is-done)')
  const t = item && state.terms.get(state.active)
  if (!t) return
  // Framed so the user just types what to do with it after the arrow.
  t.term.paste(`待辦項目: ${item.querySelector('.todo-title').textContent} → `)
  t.term.focus()
})
function setTodoHidden(hidden) {
  state.config.todoHidden = hidden
  api.setTodoPanel(hidden)
  renderTodos()
}
$('todo-close').addEventListener('click', () => setTodoHidden(!state.config.todoHidden))
// The collapsed strip expands on a click anywhere on it.
$('todo-panel').addEventListener('click', e => {
  if (state.config.todoHidden && !e.target.closest('button')) setTodoHidden(false)
})

// ---------- rename ----------

// Detect double-clicks on mousedown: the first click re-renders the tabs, so the
// second lands on a new element and a dblclick event would never fire.
document.addEventListener('mousedown', e => {
  const el = e.target.closest('[data-rename]')
  if (el && e.detail === 2) {
    e.preventDefault()
    startRename(el.dataset.rename, el)
  }
})
$('tabs').addEventListener('contextmenu', e => {
  const tab = e.target.closest('.tab')
  if (!tab) return
  e.preventDefault()
  startRename(tab.dataset.id, tab.querySelector('.title'))
})

function startRename(id, el) {
  const s = state.sessions.get(id)
  if (!s || !el || state.editing) return
  state.editing = id
  // The input replaces part of a tab or card; make the next render rebuild it.
  lastTabsHtml = ''
  const cached = cards.get(id)
  if (cached) cached.key = ''
  const input = document.createElement('input')
  input.className = 'rename'
  input.value = s.title
  input.placeholder = s.autoTitle || s.folder
  input.title = 'Enter 確認、Esc 取消；清空即恢復自動名稱'
  el.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const finish = save => {
    if (done) return
    done = true
    state.editing = null
    const value = input.value.trim()
    if (save && value !== s.title) api.rename(id, value)
    render()
    const t = state.terms.get(state.active)
    if (t) t.term.focus()
  }
  input.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Enter') finish(true)
    else if (e.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
  input.addEventListener('click', e => e.stopPropagation())
  input.addEventListener('mousedown', e => e.stopPropagation())
}

function render() {
  renderCollabButton()
  // Re-rendering would destroy the rename box; finish() renders when it closes.
  if (state.editing) return
  renderTabs()
  renderStatus()
}

// ---------- collaboration settings ----------

function renderCollabButton() {
  const c = state.config.collab
  if (!c) return
  const live = [...state.sessions.values()].filter(s => s.collab?.asking).length
  const b = $('collab-btn')
  b.classList.toggle('on', c.enabled)
  b.innerHTML = `⇄ 協作 ${c.enabled ? '開' : '關'}${live ? ` <span class="live">· ${live} 進行中</span>` : ''}`
  $('collab-stop').disabled = !live
}

function fillCollabMenu() {
  const c = state.config.collab
  $('collab-enabled').checked = c.enabled
  $('collab-asks').value = c.maxAsksPerTurn
  $('collab-depth').value = c.maxDepth
  $('collab-timeout').value = c.timeoutMin
  $('collab-open').checked = c.allowOpen
  $('collab-max-open').value = c.maxOpened
}

$('collab-btn').addEventListener('click', e => {
  e.stopPropagation()
  const menu = $('collab-menu')
  menu.hidden = !menu.hidden
  if (!menu.hidden) fillCollabMenu()
})
$('collab-menu').addEventListener('click', e => e.stopPropagation())
document.addEventListener('click', () => ($('collab-menu').hidden = true))

async function saveCollab() {
  state.config.collab = await api.setCollab({
    enabled: $('collab-enabled').checked,
    maxAsksPerTurn: $('collab-asks').value,
    maxDepth: $('collab-depth').value,
    timeoutMin: $('collab-timeout').value,
    allowOpen: $('collab-open').checked,
    maxOpened: $('collab-max-open').value,
  })
  fillCollabMenu()
  renderCollabButton()
}
for (const id of ['collab-enabled', 'collab-asks', 'collab-depth', 'collab-timeout', 'collab-open', 'collab-max-open']) $(id).addEventListener('change', saveCollab)
$('collab-stop').addEventListener('click', () => api.stopCollab())

// ---------- git panel ----------

const gitState = { cwd: null, sig: '', busy: false, data: null, hidden: false, unchecked: new Set(), op: null }
try { gitState.hidden = localStorage.getItem('gitHidden') === '1' } catch {}
// Height of the expanded Git panel, set by dragging the splitter above it.
try { gitState.height = Number(localStorage.getItem('gitHeight')) || null } catch {}

const LANE_W = 14
const ROW_H = 24
const MAX_LANES = 10
const LANE_COLORS = ['#4f9cff', '#e07a5f', '#a99bff', '#3fb950', '#f5b942', '#7dcfff', '#f778ba', '#c9d1d9']

/** The folder the panel follows: the active tab's; none without a tab. */
function gitCwd() {
  const s = state.active && state.sessions.get(state.active)
  return s?.cwd || null
}

async function refreshGit(force) {
  // A refresh asked for mid-read (e.g. right after a commit) runs once that read ends.
  if (gitState.busy) {
    gitState.again = gitState.again || (force ? 'force' : 'yes')
    return gitState.busy
  }
  const cwd = gitCwd()
  if (!cwd) {
    if (gitState.data) {
      gitState.cwd = null
      gitState.sig = ''
      gitState.data = null
      renderGit()
    }
    return
  }
  gitState.busy = (async () => {
    const data = await api.readGit(cwd)
    // The tab may have closed or switched while reading.
    if (gitCwd() !== cwd) return
    const sig = cwd + JSON.stringify(data)
    if (force || sig !== gitState.sig) {
      gitState.sig = sig
      gitState.cwd = cwd
      gitState.data = data
      renderGit()
    }
  })()
  try {
    await gitState.busy
  } finally {
    gitState.busy = false
  }
  if (gitState.again) {
    const again = gitState.again
    gitState.again = null
    await refreshGit(again === 'force')
  }
}

function setGitHidden(hidden) {
  gitState.hidden = hidden
  try { localStorage.setItem('gitHidden', hidden ? '1' : '0') } catch {}
  renderGit()
  // Collapsed, it polls slowly; catch up when it opens.
  if (!hidden) refreshGit()
}

/**
 * Lane layout: each lane holds the hash it expects next. A commit takes the
 * lane expecting it (or a free one, for a branch tip), lanes also expecting it
 * merge in, its first parent continues the lane, and other parents fork out.
 */
function layoutGraph(commits) {
  const lanes = []
  const colors = []
  let nextColor = 0
  const free = () => {
    const i = lanes.indexOf(null)
    return i < 0 ? lanes.length : i
  }
  return commits.map(c => {
    let col = lanes.indexOf(c.hash)
    const isTip = col < 0
    if (isTip) {
      col = free()
      lanes[col] = c.hash
      colors[col] = nextColor++ % LANE_COLORS.length
    }
    const before = lanes.slice()
    const beforeColors = colors.slice()
    const merging = []
    before.forEach((h, i) => {
      if (h === c.hash && i !== col) {
        merging.push(i)
        lanes[i] = null
      }
    })
    const outgoing = []
    if (c.parents.length) {
      lanes[col] = c.parents[0]
      outgoing.push(col)
      for (const p of c.parents.slice(1)) {
        let pi = lanes.indexOf(p)
        if (pi < 0) {
          pi = free()
          lanes[pi] = p
          colors[pi] = nextColor++ % LANE_COLORS.length
        }
        outgoing.push(pi)
      }
    } else {
      lanes[col] = null
    }
    while (lanes.length && lanes[lanes.length - 1] === null) {
      lanes.pop()
      colors.length = lanes.length
    }
    return { c, col, isTip, before, beforeColors, merging, outgoing, after: lanes.slice(), afterColors: colors.slice() }
  })
}

function graphSvg(row, width) {
  const x = i => i * LANE_W + LANE_W / 2
  const mid = ROW_H / 2
  const color = i => LANE_COLORS[i % LANE_COLORS.length]
  const curve = (x1, y1, x2, y2) => `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`
  const paths = []
  row.before.forEach((h, i) => {
    if (h === null || i >= MAX_LANES) return
    if (i === row.col) {
      if (!row.isTip) paths.push([`M${x(i)},0 L${x(i)},${mid}`, row.beforeColors[i]])
    } else if (row.merging.includes(i)) {
      paths.push([curve(x(i), 0, x(row.col), mid), row.beforeColors[i]])
    } else {
      paths.push([`M${x(i)},0 L${x(i)},${ROW_H}`, row.beforeColors[i]])
    }
  })
  for (const o of row.outgoing) {
    if (o >= MAX_LANES) continue
    paths.push([o === row.col ? `M${x(o)},${mid} L${x(o)},${ROW_H}` : curve(x(row.col), mid, x(o), ROW_H), row.afterColors[o]])
  }
  const nodeColor = color(row.beforeColors[row.col] ?? row.afterColors[row.col] ?? 0)
  const merge = row.c.parents.length > 1
  return `<svg width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}">
    ${paths.map(([d, ci]) => `<path d="${d}" stroke="${color(ci ?? 0)}" stroke-width="2" fill="none"/>`).join('')}
    <circle cx="${x(Math.min(row.col, MAX_LANES - 1))}" cy="${mid}" r="${merge ? 3.5 : 4}" fill="${merge ? '#151821' : nodeColor}" stroke="${nodeColor}" stroke-width="2"/>
  </svg>`
}

/** A ref from `git log --decorate=full`, e.g. `HEAD -> refs/heads/main`, `tag: refs/tags/v1`. */
function refChip(ref) {
  const chip = (cls, name) => `<span class="ref ${cls}" title="${esc(name)}">${esc(name)}</span>`
  if (ref.startsWith('HEAD -> ')) return chip('head', ref.slice(8).replace(/^refs\/heads\//, ''))
  if (ref === 'HEAD') return chip('head', 'HEAD')
  if (ref.startsWith('tag: ')) return chip('tag', ref.slice(5).replace(/^refs\/tags\//, ''))
  if (ref.startsWith('refs/remotes/')) return ref.endsWith('/HEAD') ? '' : chip('remote', ref.slice(13))
  if (ref.startsWith('refs/heads/')) return chip('', ref.slice(11))
  return ''
}

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000)
  if (m < 1) return '剛剛'
  if (m < 60) return `${m} 分前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小時前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  const mo = Math.floor(d / 30)
  return mo < 12 ? `${mo} 個月前` : `${Math.floor(mo / 12)} 年前`
}

function changeCode(code) {
  if (code === '??') return ['U', 'u', '未追蹤']
  const c = code.trim()[0] || ' '
  const map = { M: ['M', 'm', '已修改'], A: ['A', 'a', '新增'], D: ['D', 'd', '刪除'], R: ['R', 'r', '重新命名'], C: ['C', 'r', '複製'], U: ['!', 'd', '衝突'] }
  return map[c] || [c, 'm', code]
}

function renderGit() {
  const d = gitState.data
  const isRepo = !!d?.isRepo
  // Collapsed, the panel shrinks to its header bar at the bottom right.
  const panel = $('git-panel')
  panel.hidden = !isRepo
  panel.classList.toggle('collapsed', gitState.hidden)
  panel.style.flexBasis = !gitState.hidden && gitState.height ? `${gitState.height}px` : ''
  $('side-split').hidden = !isRepo || gitState.hidden
  $('git-close').textContent = gitState.hidden ? '▴' : '▾'
  $('git-close').title = gitState.hidden ? '展開' : '收起'
  if (!isRepo) return

  const sync = d.tracking ? ` <span class="sync">${esc(d.tracking.replace(/ahead /g, '↑').replace(/behind /g, '↓').replace(/,/g, ''))}</span>` : ''
  $('git-branch').innerHTML = `⑂ ${esc(d.branch || '(detached)')}${sync}`
  $('git-branch').title = d.root

  const changes = d.changes
    .map(ch => {
      const [letter, cls, label] = changeCode(ch.code)
      const p = ch.path.replace(/^"|"$/g, '')
      const shown = p.includes(' -> ') ? p.split(' -> ').pop() : p
      const i = shown.lastIndexOf('/')
      return `<div class="chg ${viewer.key === 'file:' + ch.path ? 'open' : ''}" data-path="${esc(ch.path)}" title="${esc(label)}：${esc(p)}">
        <input type="checkbox" data-check="${esc(ch.path)}" title="包含在這次提交" ${gitState.unchecked.has(ch.path) ? '' : 'checked'} />
        <span class="code ${cls}">${letter}</span>
        <span class="name">${esc(shown.slice(i + 1))}</span>
        <span class="dir"><bdi dir="ltr">${esc(i > 0 ? shown.slice(0, i) : '')}</bdi></span>
      </div>`
    })
    .join('')
  // Forget unchecked paths that are no longer changed.
  const current = new Set(d.changes.map(c => c.path))
  for (const p of gitState.unchecked) if (!current.has(p)) gitState.unchecked.delete(p)
  const allChecked = !gitState.unchecked.size
  $('git-changes').innerHTML =
    `<div class="git-sec-title">未提交變更<span class="count">${d.totalChanges}</span>` +
    (d.changes.length ? `<label class="all"><input type="checkbox" data-check-all ${allChecked ? 'checked' : ''} />全選</label>` : '') +
    `</div>` +
    (d.changes.length ? `<div class="git-changes-list">${changes}</div>` : '<div class="git-empty">工作區是乾淨的</div>')
  $('git-commit-box').hidden = !d.changes.length
  updateGitButtons()

  const rows = layoutGraph(d.commits)
  const lanes = Math.min(MAX_LANES, Math.max(1, ...rows.map(r => Math.max(r.before.length, r.after.length, r.col + 1))))
  const width = lanes * LANE_W + 6
  const commits = rows
    .map(r => {
      const c = r.c
      const tip = `${c.hash.slice(0, 8)} · ${c.author} · ${new Date(c.time).toLocaleString()}\n${c.subject}`
      return `<div class="commit ${viewer.key === 'commit:' + c.hash ? 'open' : ''}" data-hash="${c.hash}" title="${esc(tip)}">
        ${graphSvg(r, width)}
        <div class="msg">${c.refs.map(refChip).join('')}<span class="subject">${esc(c.subject)}</span></div>
        <span class="when">${ago(c.time)}</span>
      </div>`
    })
    .join('')
  // Uncommitted work sits above HEAD, on HEAD's lane.
  let wip = ''
  if (d.totalChanges) {
    const head = rows.find(r => r.c.refs.some(ref => ref === 'HEAD' || ref.startsWith('HEAD -> ')))
    const cx = Math.min(head ? head.col : 0, MAX_LANES - 1) * LANE_W + LANE_W / 2
    wip = `<div class="commit wip ${viewer.key === 'wip' ? 'open' : ''}" data-wip="1" title="尚未提交的變更">
      <svg width="${width}" height="${ROW_H}" viewBox="0 0 ${width} ${ROW_H}">
        ${head === rows[0] ? `<path d="M${cx},${ROW_H / 2} L${cx},${ROW_H}" stroke="#f5b942" stroke-width="2" stroke-dasharray="3 3"/>` : ''}
        <circle cx="${cx}" cy="${ROW_H / 2}" r="4" fill="#151821" stroke="#f5b942" stroke-width="2" stroke-dasharray="2 2"/>
      </svg>
      <div class="msg"><span class="subject">未提交變更（${d.totalChanges}）</span></div>
    </div>`
  }
  $('git-log').innerHTML =
    `<div class="git-sec-title">提交記錄<span class="count">${d.commits.length}</span></div>` +
    (d.commits.length || wip ? `<div class="git-commits">${wip}${commits}</div>` : '<div class="git-empty">還沒有任何提交</div>')
}

// ---------- diff viewer ----------

const viewer = { key: null, seq: 0 }

function showViewer(key, titleHtml) {
  viewer.key = key
  const seq = ++viewer.seq
  $('viewer-title').innerHTML = titleHtml
  $('viewer-body').innerHTML = '<div class="viewer-loading">讀取中…</div>'
  $('viewer').hidden = false
  $('viewer').focus()
  renderGit()
  return seq
}

function closeViewer() {
  if ($('viewer').hidden) return
  $('viewer').hidden = true
  viewer.key = null
  renderGit()
  const t = state.terms.get(state.active)
  if (t) t.term.focus()
}

/** Splits a unified diff into files with numbered lines. */
function parseDiff(patch) {
  const files = []
  let f = null
  let oldNo = 0
  let newNo = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/)
      f = { path: m ? m[2] : line.slice(11), from: m ? m[1] : null, lines: [], add: 0, del: 0, tag: '', binary: false }
      files.push(f)
      continue
    }
    if (!f) continue
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) {
        oldNo = +m[1]
        newNo = +m[2]
      }
      f.lines.push({ t: 'hunk', text: line })
    } else if (f.lines.length) {
      if (line.startsWith('+')) {
        f.lines.push({ t: 'add', n: newNo++, text: line.slice(1) })
        f.add++
      } else if (line.startsWith('-')) {
        f.lines.push({ t: 'del', o: oldNo++, text: line.slice(1) })
        f.del++
      } else if (line.startsWith(' ')) {
        f.lines.push({ t: 'ctx', o: oldNo++, n: newNo++, text: line.slice(1) })
      }
    } else if (/^new file/.test(line)) f.tag = '新增'
    else if (/^deleted file/.test(line)) f.tag = '刪除'
    else if (/^rename from/.test(line)) f.tag = '重新命名'
    else if (/^Binary file/.test(line)) f.binary = true
  }
  return files
}

const MAX_LINES_PER_FILE = 3000

function renderDiff(patch, truncated) {
  const files = parseDiff(patch)
  if (!files.length) return '<div class="dnote">沒有內容差異</div>'
  const summary = files
    .map((f, i) => `<div class="row" data-jump="${i}"><span class="p">${esc(f.path)}</span>${f.tag ? `<span class="tag">${f.tag}</span>` : ''}<span class="stat-add">+${f.add}</span><span class="stat-del">−${f.del}</span></div>`)
    .join('')
  const blocks = files
    .map((f, i) => {
      const shown = f.lines.slice(0, MAX_LINES_PER_FILE)
      const lines = shown
        .map(l =>
          l.t === 'hunk'
            ? `<div class="dline hunk"><span class="no"></span><span class="no"></span><span class="code">${esc(l.text)}</span></div>`
            : `<div class="dline ${l.t}"><span class="no">${l.o ?? ''}</span><span class="no">${l.n ?? ''}</span><span class="code">${esc(l.text) || ' '}</span></div>`,
        )
        .join('')
      const note = f.binary
        ? '<div class="dnote">二進位檔案，無法顯示內容</div>'
        : !f.lines.length
          ? '<div class="dnote">沒有內容變更（可能只有權限或名稱變更）</div>'
          : f.lines.length > MAX_LINES_PER_FILE
            ? `<div class="dnote">…還有 ${f.lines.length - MAX_LINES_PER_FILE} 行未顯示</div>`
            : ''
      const title = f.from && f.from !== f.path ? `${f.from} → ${f.path}` : f.path
      return `<div class="dfile" id="dfile-${i}">
        <div class="dfile-head" data-toggle="${i}" title="點擊收合／展開"><span class="p">${esc(title)}</span>${f.tag ? `<span class="tag">${f.tag}</span>` : ''}<span class="stat-add">+${f.add}</span><span class="stat-del">−${f.del}</span></div>
        ${f.lines.length ? `<div class="dtable">${lines}</div>` : ''}${note}
      </div>`
    })
    .join('')
  return (
    (truncated ? '<div class="truncated">差異內容太大，只顯示前 1.5 MB。</div>' : '') +
    (files.length > 1 ? `<div class="diff-summary">${summary}</div>` : '') +
    blocks
  )
}

async function openCommit(hash) {
  const seq = showViewer('commit:' + hash, `提交 <span class="sub">${hash.slice(0, 8)}</span>`)
  const c = await api.gitShow(gitState.cwd, hash)
  if (seq !== viewer.seq) return
  if (c.error) return ($('viewer-body').innerHTML = `<div class="dnote">${esc(c.error)}</div>`)
  const [subject, ...rest] = c.message.split('\n')
  const body = rest.join('\n').trim()
  $('viewer-title').innerHTML = `${esc(subject)} <span class="sub">${c.hash.slice(0, 8)}</span>`
  $('viewer-body').innerHTML = `
    ${body ? `<div class="cm-body">${esc(body)}</div>` : ''}
    <dl class="cm-meta">
      <dt>Commit</dt><dd><span class="copy" data-copy="${c.hash}" title="點擊複製">${c.hash}</span></dd>
      <dt>作者</dt><dd>${esc(c.author)} &lt;${esc(c.email)}&gt;</dd>
      <dt>時間</dt><dd>${new Date(c.time).toLocaleString()}（${ago(c.time)}）</dd>
      ${c.parents.length ? `<dt>上層</dt><dd>${c.parents.map(p => `<span class="copy" data-open="${p}" title="開啟這個提交">${p.slice(0, 8)}</span>`).join('　')}${c.parents.length > 1 ? '（合併提交，差異以第一個上層為準）' : ''}</dd>` : ''}
    </dl>
    ${renderDiff(c.patch, c.truncated)}`
}

async function openWorking(rel) {
  const key = rel ? 'file:' + rel : 'wip'
  const seq = showViewer(key, rel ? `未提交變更 <span class="sub">${esc(rel)}</span>` : '未提交變更')
  const w = await api.gitWorkingDiff(gitState.cwd, rel)
  if (seq !== viewer.seq) return
  $('viewer-body').innerHTML = w.error ? `<div class="dnote">${esc(w.error)}</div>` : renderDiff(w.patch, w.truncated)
}

$('git-log').addEventListener('click', e => {
  const row = e.target.closest('.commit')
  if (!row) return
  if (row.dataset.wip) openWorking()
  else openCommit(row.dataset.hash)
})
$('git-changes').addEventListener('click', e => {
  if (e.target.matches('[data-check-all]')) {
    gitState.unchecked = e.target.checked ? new Set() : new Set(gitState.data.changes.map(c => c.path))
    for (const box of $('git-changes').querySelectorAll('[data-check]')) box.checked = e.target.checked
    updateGitButtons()
    return
  }
  if (e.target.matches('[data-check]')) {
    const p = e.target.dataset.check
    if (e.target.checked) gitState.unchecked.delete(p)
    else gitState.unchecked.add(p)
    $('git-changes').querySelector('[data-check-all]').checked = !gitState.unchecked.size
    updateGitButtons()
    return
  }
  const row = e.target.closest('.chg')
  if (row) openWorking(row.dataset.path)
})

// ---------- pull / push / commit ----------

function selectedChanges() {
  return (gitState.data?.changes || []).filter(c => !gitState.unchecked.has(c.path))
}

function updateGitButtons() {
  const d = gitState.data
  if (!d?.isRepo) return
  const ahead = d.tracking?.match(/ahead (\d+)/)?.[1] || ''
  const behind = d.tracking?.match(/behind (\d+)/)?.[1] || ''
  $('git-ahead').textContent = ahead
  $('git-behind').textContent = behind
  const op = gitState.op
  $('git-pull').disabled = $('git-push').disabled = !!op
  $('git-pull').classList.toggle('busy', op === 'pull')
  $('git-push').classList.toggle('busy', op === 'push')
  $('git-pull').firstChild.textContent = op === 'pull' ? '↓ 拉取中…' : '↓ 拉取'
  $('git-push').firstChild.textContent = op === 'push' ? '↑ 推送中…' : '↑ 推送'
  const n = selectedChanges().length
  $('git-commit').disabled = !!op || !n
  $('git-commit').textContent = op === 'commit' ? '提交中…' : n ? `✓ 提交 ${n} 個檔案` : '請勾選要提交的檔案'
}

async function gitOp(op, fn, onOk) {
  if (gitState.op) return
  const cwd = gitState.cwd
  gitState.op = op
  updateGitButtons()
  try {
    const r = await fn(cwd)
    if (r.error) toast(r.error)
    else {
      toast(r.message, 'info')
      onOk?.()
    }
  } finally {
    gitState.op = null
    await refreshGit(true)
    updateGitButtons()
  }
}

$('git-pull').addEventListener('click', () => gitOp('pull', api.gitPull))
$('git-push').addEventListener('click', () => gitOp('push', api.gitPush))

function commitSelected() {
  const message = $('git-message').value.trim()
  if (!message) {
    toast('請先輸入提交訊息')
    $('git-message').focus()
    return
  }
  const paths = selectedChanges().flatMap(c => (c.from ? [c.from, c.path] : [c.path]))
  gitOp('commit', cwd => api.gitCommit(cwd, message, paths), () => {
    $('git-message').value = ''
    gitState.unchecked.clear()
    if (viewer.key === 'wip' || viewer.key?.startsWith('file:')) closeViewer()
  })
}
$('git-commit').addEventListener('click', commitSelected)
$('git-message').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault()
    commitSelected()
  }
})
$('viewer-close').addEventListener('click', closeViewer)
$('viewer').addEventListener('keydown', e => {
  if (e.key === 'Escape') closeViewer()
})
$('viewer-body').addEventListener('click', e => {
  const copy = e.target.closest('[data-copy]')
  if (copy) {
    api.writeClipboard(copy.dataset.copy)
    toast(`已複製 ${copy.dataset.copy.slice(0, 8)}`, 'info')
    return
  }
  const open = e.target.closest('[data-open]')
  if (open) return openCommit(open.dataset.open)
  const jump = e.target.closest('[data-jump]')
  if (jump) {
    const el = $('dfile-' + jump.dataset.jump)
    el.classList.remove('collapsed')
    el.scrollIntoView({ block: 'start' })
    return
  }
  const toggle = e.target.closest('[data-toggle]')
  if (toggle) $('dfile-' + toggle.dataset.toggle).classList.toggle('collapsed')
})
$('git-refresh').addEventListener('click', () => refreshGit(true))
$('git-close').addEventListener('click', () => setGitHidden(!gitState.hidden))
// The collapsed bar expands on a click anywhere outside its buttons.
document.querySelector('#git-panel .panel-head').addEventListener('click', e => {
  if (gitState.hidden && !e.target.closest('button')) setGitHidden(false)
})
$('side-split').addEventListener('mousedown', e => {
  e.preventDefault()
  const side = $('side-split').parentElement.getBoundingClientRect()
  const split = $('side-split')
  split.classList.add('dragging')
  const move = ev => {
    // Leave room for the status panel above (its min-height) and a usable Git panel.
    const h = Math.round(Math.min(side.height - 160, Math.max(120, side.bottom - ev.clientY)))
    gitState.height = h
    $('git-panel').style.flexBasis = `${h}px`
  }
  const up = () => {
    split.classList.remove('dragging')
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    try { localStorage.setItem('gitHeight', String(gitState.height)) } catch {}
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
})
// Every 4 s while the window is in front and the panel open; every ~15 s when
// behind other windows or collapsed to its bar; not at all when minimized.
let lastGitPoll = 0
setInterval(() => {
  const slow = !document.hasFocus() || gitState.hidden
  if (document.hidden || (slow && Date.now() - lastGitPoll < 15000)) return
  lastGitPoll = Date.now()
  refreshGit()
}, 4000)
window.addEventListener('focus', () => refreshGit())

// ---------- events ----------

for (const b of document.querySelectorAll('[data-kind]')) {
  b.addEventListener('click', () => launch(b.dataset.kind))
}
// Shown only when the checkout is behind its remote branch.
function renderAppUpdate() {
  const u = state.appUpdate || {}
  const b = $('app-update')
  b.hidden = u.state !== 'available' && u.state !== 'updating'
  b.disabled = u.state === 'updating'
  const to = u.version && u.version !== state.version ? ` 到 v${u.version}` : ''
  b.textContent = u.state === 'updating' ? '更新中…' : `⬆ 更新${to}`
  b.title = u.state !== 'available' ? ''
    : u.ready ? `新版本 v${u.version} 已下載，按下後安裝並重開（不按的話會在關閉 App 時安裝）`
    : `GitHub 上有 ${u.behind} 個新的 commit，按下後下載並重開`
}
api.onAppUpdate(u => {
  state.appUpdate = u
  renderAppUpdate()
})
$('app-update').addEventListener('click', async () => {
  const r = await api.runAppUpdate()
  if (r.error) toast(r.error)
})

// ---------- now playing ----------

// Whatever Windows' media keys control right now (Spotify, a browser tab, ...).
// Simplified brand marks, 16×16, for where the media comes from.
const MEDIA_ICONS = {
  spotify: '<circle cx="8" cy="8" r="8" fill="#1db954"/><path d="M4 6.2c2.7-.8 5.6-.6 8 .7M4.6 8.6c2.2-.6 4.5-.4 6.4.6M5.2 10.8c1.7-.4 3.4-.3 4.9.4" stroke="#111" stroke-width="1.3" fill="none" stroke-linecap="round"/>',
  youtube: '<rect x="0" y="2.5" width="16" height="11" rx="3" fill="#ff0033"/><path d="M6.5 5.4v5.2L11 8z" fill="#fff"/>',
  ytmusic: '<circle cx="8" cy="8" r="8" fill="#ff0033"/><circle cx="8" cy="8" r="4.6" stroke="#fff" stroke-width="1.1" fill="none"/><path d="M6.8 6v4L10 8z" fill="#fff"/>',
  netflix: '<rect width="16" height="16" rx="3" fill="#111"/><path d="M5 3h2.2l1.8 5.6V3H11v10H8.8L7 7.4V13H5z" fill="#e50914"/>',
  twitch: '<path d="M2.5 1 1.5 3.5V13h3v2h2l2-2h2.5l3.5-3.5V1z" fill="#9146ff"/><path d="M7 4.5h1.3v3.6H7zm3.4 0h1.3v3.6h-1.3z" fill="#fff"/>',
  soundcloud: '<path d="M6 12V6.2a4 4 0 0 1 7 2.5A2.2 2.2 0 0 1 13 12.9H6zM1 12V9h1v3zm2 0V7.5h1V12zm2 0V6.5h.7V12z" fill="#ff5500"/>',
  bilibili: '<rect x=".5" y="3.5" width="15" height="11" rx="2.5" fill="#00a1d6"/><path d="M4.5 1.5 6.5 3.5M11.5 1.5 9.5 3.5" stroke="#00a1d6" stroke-width="1.3" stroke-linecap="round"/><path d="M5 8v1.5M11 8v1.5" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>',
  apple: '<rect width="16" height="16" rx="4" fill="#fa2d48"/><path d="M10.8 3.2v6.6a1.6 1.6 0 1 1-1-1.5V5.4L6.6 6.1v5a1.6 1.6 0 1 1-1-1.5V4.6z" fill="#fff"/>',
  chrome: '<circle cx="8" cy="8" r="8" fill="#ea4335"/><path d="M8 8 1.1 4A8 8 0 0 0 8 16z" fill="#34a853"/><path d="M8 8h6.9A8 8 0 0 1 8 16z" fill="#fbbc04"/><circle cx="8" cy="8" r="3.6" fill="#fff"/><circle cx="8" cy="8" r="2.7" fill="#4285f4"/>',
  edge: '<circle cx="8" cy="8" r="8" fill="#0c84d8"/><path d="M3 9.5c.6-3.5 5-5.4 8.2-3.2 1.5 1 1.6 3 .2 3.6-1.4.6-4.5.2-4.5 2 0 1.4 2.2 2 4.2 1.4A6.5 6.5 0 0 1 3 9.5z" fill="#42e08a"/>',
  firefox: '<circle cx="8" cy="8" r="8" fill="#ff7139"/><circle cx="8.6" cy="8.4" r="4.4" fill="#7542e5"/><path d="M2 6.5c1-3 4-4.6 7-4.2-2 .7-3.2 2.4-3.2 4.2" fill="#ffbd4f"/>',
  brave: '<path d="M8 1 13.5 3 13 10 8 15 3 10 2.5 3z" fill="#fb542b"/><path d="M8 5 10 7 8 11 6 7z" fill="#fff"/>',
  opera: '<circle cx="8" cy="8" r="8" fill="#ff1b2d"/><ellipse cx="8" cy="8" rx="2.6" ry="4.6" fill="#fff"/>',
  music: '<rect width="16" height="16" rx="4" fill="#3a4258"/><path d="M10.8 3.2v6.6a1.6 1.6 0 1 1-1-1.5V5.4L6.6 6.1v5a1.6 1.6 0 1 1-1-1.5V4.6z" fill="#e6e8ef"/>',
}
// Each mark's brand color, for the widget's frame.
const MEDIA_COLORS = {
  spotify: '#1db954', youtube: '#ff0033', ytmusic: '#ff0033', netflix: '#e50914', twitch: '#9146ff',
  soundcloud: '#ff5500', bilibili: '#00a1d6', apple: '#fa2d48', chrome: '#4285f4', edge: '#0c84d8',
  firefox: '#ff7139', brave: '#fb542b', opera: '#ff1b2d', music: '#8a90a2',
}
const MEDIA_SITES = { 'YouTube Music': 'ytmusic', YouTube: 'youtube', Netflix: 'netflix', Twitch: 'twitch', SoundCloud: 'soundcloud', bilibili: 'bilibili', Spotify: 'spotify', 'Apple Music': 'apple' }
const MEDIA_APPS = [
  [/spotify/i, 'Spotify', 'spotify'], [/chrome/i, 'Chrome', 'chrome'], [/msedge|edge/i, 'Edge', 'edge'],
  [/firefox|308046B0AF4A39CB/i, 'Firefox', 'firefox'], [/brave/i, 'Brave', 'brave'], [/opera/i, 'Opera', 'opera'],
  [/applemusic|itunes/i, 'Apple Music', 'apple'], [/zunemusic/i, '媒體播放器', 'music'],
]
/** Where the media plays: the site inside a browser when known, else the app. */
function mediaSource(m) {
  const [, appName, appIcon] = MEDIA_APPS.find(([re]) => re.test(m.app || '')) || [null, (m.app || '').split('!').pop().replace(/\.exe$/i, '') || '媒體', 'music']
  if (m.site && m.site !== appName) return { name: `${m.site} · ${appName}`, icon: MEDIA_SITES[m.site] || appIcon }
  return { name: appName, icon: appIcon }
}
function renderMedia(m) {
  $('media').hidden = !m
  if (!m) return
  const playing = m.status === 'Playing'
  // Assigning the same data URL again would make the image flicker.
  if (m.cover && $('media-cover').src !== m.cover) $('media-cover').src = m.cover
  $('media-cover').hidden = !m.cover
  $('media-icon').hidden = !!m.cover
  $('media-title').textContent = m.title
  const src = mediaSource(m)
  const icon = `<svg viewBox="0 0 16 16" aria-hidden="true">${MEDIA_ICONS[src.icon]}</svg>`
  // Without a cover, the source's mark stands in for it.
  $('media-icon').innerHTML = icon
  $('media-artist').textContent = m.artist || ''
  $('media-artist').hidden = !m.artist
  $('media-source').innerHTML = `${icon}<span>${esc(src.name)}</span>`
  $('media').style.setProperty('--media-accent', MEDIA_COLORS[src.icon])
  $('media').title = `${m.title}${m.artist ? ` — ${m.artist}` : ''}（${src.name}）`
  $('media-toggle').textContent = playing ? '❚❚' : '▶'
  $('media-toggle').title = playing ? '暫停' : '播放'
  $('media-prev').disabled = !m.canPrev
  $('media-next').disabled = !m.canNext
}
api.onMedia(renderMedia)
$('media').addEventListener('click', e => {
  const command = e.target.closest('[data-media]')?.dataset.media
  if (command) api.mediaControl(command)
})

// Log in from a Terminal tab running the CLI's login command; once that
// command finishes, refresh the quotas.
const LOGIN_COMMAND = { claude: 'claude auth login', codex: 'codex login' }
const loginTabs = new Set()
$('usage').addEventListener('click', async e => {
  const kind = e.target.closest('[data-login]')?.dataset.login
  if (!kind) return
  const id = await launch('shell')
  if (!id) return
  loginTabs.add(id)
  api.rename(id, `${KIND[kind].name} 登入`)
  api.input(id, `${LOGIN_COMMAND[kind]}\r`)
})

$('refresh-usage').addEventListener('click', e => {
  e.currentTarget.classList.remove('spin')
  void e.currentTarget.offsetWidth
  e.currentTarget.classList.add('spin')
  api.refreshUsage()
})

document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Tab') {
    const ids = [...state.sessions.keys()]
    if (ids.length < 2) return
    const i = ids.indexOf(state.active)
    select(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length])
    e.preventDefault()
  }
})

api.onData((id, data) => {
  const t = state.terms.get(id)
  if (t) t.term.write(data)
  else {
    if (!state.pending.has(id)) state.pending.set(id, [])
    state.pending.get(id).push(data)
  }
})
api.onSessionUpdate(s => {
  const prev = state.sessions.get(s.id)
  if (!prev && !state.terms.has(s.id)) {
    // Update for a session still being created; launch() will add it.
    state.sessions.set(s.id, s)
    return
  }
  // A turn that answered another session reports back there, not here.
  if (loginTabs.has(s.id) && prev?.status === 'working' && s.status !== 'working') {
    loginTabs.delete(s.id)
    api.refreshUsage()
  }
  if (prev && prev.status !== s.status && s.id !== state.active && s.status !== 'working' && !s.collab?.serving) state.attention.add(s.id)
  // Woken: drop the placeholder before the CLI's first output (the update arrives first).
  if (prev?.dormant && !s.dormant) state.terms.get(s.id)?.term.reset()
  state.sessions.set(s.id, s)
  scheduleRender()
})
// Updates come in bursts while sessions work; draw at most once per frame.
let renderQueued = false
function scheduleRender() {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    render()
  })
}
api.onSessionRemoved(removeSession)
api.onSessionSelect(select)
api.onSessionSpawn(async (req, kind, restore) => {
  const id = await launch(kind, restore, { background: true })
  api.spawned(req, id ? { id } : { error: '開啟失敗' })
})
api.onTodos(list => {
  state.todos = list
  for (const id of todoUi.completing) if (!list.some(t => t.id === id && !t.done)) todoUi.completing.delete(id)
  renderTodos()
})
api.onCollabEvent(e =>toast(`⇄ 已阻擋「${e.title}」的協作請求：${e.text}`, 'info'))
api.onUsage(u => {
  state.usage = u
  renderUsage()
})
api.onUpdateState(u => {
  for (const kind of ['claude', 'codex']) {
    const was = state.updates?.[kind]?.state
    const now = u[kind]
    if (was === 'updating' && now.state === 'updated') toast(`${KIND[kind].name} 已更新：v${now.before} → v${now.after}`, 'info')
    if (was === 'updating' && now.state === 'error') toast(`${KIND[kind].name} 更新失敗：${now.message || ''}`)
  }
  state.updates = u
  renderUsage()
})

const ro = new ResizeObserver(() => {
  const t = state.active && state.terms.get(state.active)
  if (t) try { t.fit.fit() } catch {}
})
ro.observe($('terms'))

setInterval(renderUsage, 30000)

api.init().then(async ({ config, usage, updates, sessions, version, appUpdate, media, todos, todoWidth }) => {
  state.config = config
  state.todos = todos || []
  state.todoWidth = todoWidth
  renderTodos()
  renderMedia(media)
  state.version = version
  state.appUpdate = appUpdate
  renderAppUpdate()
  state.usage = usage
  state.updates = updates
  renderDir()
  renderUsage()
  render()
  refreshGit()
  // Reopen last time's tabs (not on a window reload, where the sessions still live).
  // Only the tab that was showing resumes right away; the rest wait until selected.
  const tabs = sessions.length ? [] : config.tabs || []
  const shown = tabs[config.activeTab] ? config.activeTab : tabs.length - 1
  const ids = []
  for (const [i, tab] of tabs.entries()) ids.push(await launch(tab.kind, { ...tab, lazy: i !== shown }, { background: i !== shown }))
  if (tabs.length) select(ids[shown] ?? state.active)
  api.tabsRestored()
})
