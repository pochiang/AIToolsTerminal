// Jev (TypeSafe AI) as a gate on collaboration: before one session asks
// another, Jev scores whether handing this request to another agent is worth
// it. Below the threshold the ask is refused and the caller does it alone.
//
// The API key is encrypted with the OS keychain (DPAPI on Windows) and never
// leaves the main process.

const { safeStorage } = require('electron')

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const TIMEOUT_MS = 10000

const QUESTION =
  'Handing this request to the other AI agent is worthwhile: it needs a second opinion, an independent review, ' +
  'or work that can run in parallel, and the other agent is relevant to it (same project or topic). ' +
  'It is NOT worthwhile when the requester could simply do it alone, the request is trivial, ' +
  'or the other agent is busy with something unrelated.'

function saveKey(config, key) {
  key = String(key || '').trim()
  if (!key) delete config.jevKey
  else config.jevKey = safeStorage.isEncryptionAvailable()
    ? { enc: safeStorage.encryptString(key).toString('base64') }
    : { plain: key }
}

function loadKey(config) {
  const k = config.jevKey
  if (!k) return ''
  try { return k.enc ? safeStorage.decryptString(Buffer.from(k.enc, 'base64')) : k.plain || '' } catch { return '' }
}

async function ask(key, state) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: 'jev-latest', questions: { delegate: { type: 'noul', instructions: QUESTION } } }),
      signal: ctl.signal,
    })
    const body = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`)
    const score = JSON.parse(body).answers?.delegate?.noul
    if (!Number.isFinite(score)) throw new Error('回應格式不符')
    return score
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? '逾時' : e.message)
  } finally {
    clearTimeout(timer)
  }
}

/** Returns { score } or { error }; never throws. */
async function judge(config, { from, to, task, message }) {
  const key = loadKey(config)
  if (!key) return { error: '尚未設定 API 金鑰' }
  const state = {
    requester: from,
    requester_current_task: task || '(unknown)',
    request_to_other_agent: message,
    other_agent: to,
  }
  try { return { score: await ask(key, state) } } catch (e) { return { error: e.message } }
}

/** Checks the key with a trivial request. */
async function test(config) {
  const key = loadKey(config)
  if (!key) return { error: '尚未設定 API 金鑰' }
  try {
    await ask(key, 'Connectivity check.')
    return { ok: true }
  } catch (e) {
    return { error: e.message }
  }
}

module.exports = { saveKey, loadKey, judge, test }
