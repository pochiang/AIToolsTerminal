// AI-to-AI collaboration: relays an `ask_session` call from one session into
// another, waits for that session's turn to finish, and returns its reply.
//
// Loop guards (none of these can be bypassed by the models):
// - cycle: a session cannot ask anyone upstream of it (who is waiting on it);
// - depth: a relay chain A -> B -> C is capped at `maxDepth` hops;
// - budget: each session gets `maxAsksPerTurn` asks per turn, refilled only
//   when a human presses Enter in it or it receives a new request;
// - timeout: a request gives up after `timeoutMin` minutes;
// - the global switch and "stop all" in the UI.
//
// `open_session` lets a session start a new one to ask (off by default); at
// most `maxOpened` AI-opened sessions run at once, in the opener's folder.

const path = require('path')

const DEFAULTS = { enabled: true, maxAsksPerTurn: 3, maxDepth: 2, timeoutMin: 10, allowOpen: false, maxOpened: 2 }
const KIND_NAME = { claude: 'Claude Code', codex: 'Codex' }
const STATUS_NAME = { working: '工作中', waiting: '等待中', done: '完成' }

const ok = text => ({ text })
const fail = text => ({ text, isError: true })

function createCollab({ sessions, config, saveConfig, send, update, titleOf, spawn, cancelSpawns }) {
  config.collab = { ...DEFAULTS, ...(config.collab || {}) }
  const requests = new Map()
  let seq = 0
  let opening = 0

  const limits = () => config.collab

  /** Sessions waiting, directly or through a chain, on `s`'s answer. */
  function upstream(s) {
    const out = []
    let r = s.serving && requests.get(s.serving)
    while (r && !out.includes(r.from)) {
      out.push(r.from)
      const from = sessions.get(r.from)
      r = from?.serving && requests.get(from.serving)
    }
    return out
  }

  function blocked(s, text) {
    send('collab:event', { title: titleOf(s), text })
    return fail(text)
  }

  function listSessions(s) {
    const L = limits()
    const others = [...sessions.values()].filter(o => o.id !== s.id && !o.exited)
    const same = o => path.resolve(o.cwd).toLowerCase() === path.resolve(s.cwd).toLowerCase()
    const lines = others.map(
      o => `- ${o.id}｜${KIND_NAME[o.kind]}${o.aiOpened ? '（AI 開啟）' : ''}｜「${titleOf(o)}」｜${same(o) ? '與你同資料夾' : `不同資料夾（${o.folder}）`}｜${STATUS_NAME[o.status] || o.status}` +
        (upstream(s).includes(o.id) ? '｜正在等你回覆（不可詢問）' : ''),
    )
    // Pick by what the other session is working on, not just what it can do.
    const hint =
      '只詢問與對方目前工作相關的對話（同資料夾或同主題），不要把無關任務交給正在做別的事的對話；' +
      (L.allowOpen ? '沒有相關的對話時，請用 open_session 開新的。' : '沒有相關的對話時請自行完成。')
    return ok(
      (lines.length ? `其他對話：\n${lines.join('\n')}` : '目前沒有其他對話。') +
        `\n\n${hint}` +
        `\n協作${L.enabled ? '已開啟' : '已關閉'}；本回合剩餘詢問次數 ${Math.max(0, L.maxAsksPerTurn - s.asksThisTurn)}/${L.maxAsksPerTurn}。`,
    )
  }

  async function call(fromId, tool, args, signal) {
    const s = sessions.get(fromId)
    if (!s) return fail('找不到呼叫端對話。')
    if (tool === 'list_sessions') return listSessions(s)
    if (tool === 'open_session') return open(s, args, signal)
    if (tool !== 'ask_session') return fail(`未知的工具：${tool}`)

    const L = limits()
    if (!L.enabled) return blocked(s, '使用者已關閉 AI 協作功能，請自行完成工作。')
    const target = sessions.get(String(args.session_id || '').trim())
    if (!target || target.exited) return fail('找不到該對話或它已結束，請先呼叫 list_sessions。')
    if (target.id === s.id) return fail('不能詢問自己。')
    const message = String(args.message || '').trim()
    if (!message) return fail('訊息不可為空。')
    if (upstream(s).includes(target.id))
      return blocked(s, `「${titleOf(target)}」正在等你的回覆，不能反問它（避免循環）。請直接完成並回覆。`)
    const parent = s.serving ? requests.get(s.serving) : null
    const depth = (parent?.depth || 0) + 1
    if (depth > L.maxDepth)
      return blocked(s, `已達最大轉介層數 ${L.maxDepth}，不能再轉問其他對話。請根據現有資訊自行回答。`)
    if (s.asksThisTurn >= L.maxAsksPerTurn)
      return blocked(s, `本回合已詢問 ${s.asksThisTurn} 次，達到上限 ${L.maxAsksPerTurn}。請整合目前的回覆完成工作，不要再呼叫 ask_session。`)

    s.asksThisTurn++
    const r = { id: `r${++seq}`, from: s.id, to: target.id, depth, message, state: 'queued' }
    requests.set(r.id, r)
    s.waitingOn = r.id
    update(s)
    update(target)
    try {
      return await run(r, signal)
    } finally {
      requests.delete(r.id)
      s.waitingOn = null
      const t = sessions.get(r.to)
      if (t?.serving === r.id) t.serving = null
      update(s)
      if (t) update(t)
    }
  }

  async function open(s, args, signal) {
    const L = limits()
    if (!L.enabled) return blocked(s, '使用者已關閉 AI 協作功能，請自行完成工作。')
    if (!L.allowOpen) return blocked(s, '使用者沒有允許 AI 開新對話。請用 list_sessions 找現有對話，或自行完成工作。')
    const live = [...sessions.values()].filter(o => o.aiOpened && !o.exited).length + opening
    if (live >= L.maxOpened)
      return blocked(s, `AI 開啟的對話已達上限 ${L.maxOpened} 個。請用 list_sessions 找現有對話詢問，或自行完成工作。`)
    // Default to the other model: a second opinion is worth more from a different one.
    const kind = args.kind === 'claude' || args.kind === 'codex' ? args.kind : s.kind === 'claude' ? 'codex' : 'claude'
    opening++
    let r
    try { r = await spawn(kind, s.cwd, signal) } finally { opening-- }
    if (r.error) return fail(`無法開啟對話：${r.error}`)
    return ok(
      `已在背景開啟 ${KIND_NAME[kind]} 對話 ${r.id}（資料夾 ${s.folder}）。` +
        '請用 ask_session 詢問它；它看不到你的對話，訊息需自帶完整背景。',
    )
  }

  // A CLI that just started is still drawing its UI and would drop typed text;
  // wait for its output to settle first.
  const ready = t => Date.now() - t.startedAt > 60000 || (t.lastOutputAt && Date.now() - t.lastOutputAt > 2000)

  function run(r, signal) {
    return new Promise(resolve => {
      const L = limits()
      const deadline = Date.now() + L.timeoutMin * 60000
      r.finish = result => {
        if (r.done) return
        r.done = true
        clearInterval(r.timer)
        resolve(result)
      }
      signal.abort = () => r.finish(fail('已取消。'))
      const tick = () => {
        const t = sessions.get(r.to)
        if (!t || t.exited) return r.finish(fail('對方對話已關閉。'))
        if (Date.now() > deadline)
          return r.finish(fail(`等待超過 ${L.timeoutMin} 分鐘仍未完成，已放棄；對方可能仍在分頁中繼續執行。`))
        // Deliver once the target is idle and not already answering someone.
        if (r.state === 'queued' && t.status !== 'working' && !t.serving && !t.awaitingApproval && ready(t)) deliver(r, t)
      }
      r.timer = setInterval(tick, 500)
      tick()
    })
  }

  function deliver(r, t) {
    const from = sessions.get(r.from)
    r.state = 'sent'
    r.seqAtSend = t.doneSeq
    t.serving = r.id
    t.asksThisTurn = 0
    const last = r.depth >= limits().maxDepth
    const text =
      `[AI 協作] 來自 ${KIND_NAME[from.kind]}「${titleOf(from)}」（${from.id}）的請求。你這一回合的最後回覆會自動傳回給它。\n\n` +
      `${r.message}\n\n` +
      `（請直接完成並回覆，不要反問對方${last ? '，也不要再呼叫 ask_session' : ''}。` +
      '如果這個請求與你目前的工作無關或不適合在這裡做，可以直接回覆拒絕並說明原因，建議對方另開新對話。）'
    t.pty.write(`\x1b[200~${text}\x1b[201~`)
    setTimeout(() => t.pty?.write('\r'), 500)
    update(t)
    update(from)
  }

  /** Called when `t` finishes a turn. Returns whether that turn answered a request. */
  function onDone(t, aborted) {
    let answered = false
    for (const r of requests.values()) {
      if (r.to !== t.id || r.state !== 'sent' || t.doneSeq <= r.seqAtSend) continue
      answered = true
      if (aborted) r.finish(fail('對方的回合被中斷，沒有回覆。'))
      else r.finish(ok(`${KIND_NAME[t.kind]}「${titleOf(t)}」回覆：\n\n${t.lastReply || '（沒有文字回覆）'}`))
    }
    return answered
  }

  function stopAll() {
    cancelSpawns()
    for (const r of requests.values())
      r.finish?.(fail('使用者已停止所有協作請求。請自行完成工作，不要再呼叫 ask_session。'))
  }

  function describe(s) {
    const asking = s.waitingOn && requests.get(s.waitingOn)
    const serving = s.serving && requests.get(s.serving)
    const t = asking && sessions.get(asking.to)
    const f = serving && sessions.get(serving.from)
    return {
      asking: asking ? { title: t ? titleOf(t) : '?', queued: asking.state === 'queued' } : null,
      serving: serving ? { title: f ? titleOf(f) : '?' } : null,
    }
  }

  function setLimits(next) {
    const n = (v, min, max, d) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, Math.round(+v))) : d)
    const c = config.collab
    config.collab = {
      enabled: next.enabled === undefined ? c.enabled : !!next.enabled,
      maxAsksPerTurn: n(next.maxAsksPerTurn ?? c.maxAsksPerTurn, 1, 20, c.maxAsksPerTurn),
      maxDepth: n(next.maxDepth ?? c.maxDepth, 1, 5, c.maxDepth),
      timeoutMin: n(next.timeoutMin ?? c.timeoutMin, 1, 60, c.timeoutMin),
      allowOpen: next.allowOpen === undefined ? c.allowOpen : !!next.allowOpen,
      maxOpened: n(next.maxOpened ?? c.maxOpened, 1, 5, c.maxOpened),
    }
    saveConfig()
    if (!config.collab.enabled) stopAll()
    else if (!config.collab.allowOpen) cancelSpawns()
    return config.collab
  }

  return { call, onDone, stopAll, describe, setLimits, pending: () => requests.size }
}

module.exports = { createCollab }
