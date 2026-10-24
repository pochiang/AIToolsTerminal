// Stdio MCP server that Claude Code / Codex sessions launched by AI Tools
// Terminal load. It forwards tool calls to the app, which relays messages
// between sessions and enforces the collaboration limits.
const http = require('http')

const { AITT_PORT, AITT_SESSION, AITT_TOKEN } = process.env

const TOOLS = [
  {
    name: 'list_sessions',
    description:
      '列出 AI Tools Terminal 中其他正在執行的 AI 對話（Claude Code / Codex），包含 id、名稱、資料夾與狀態。在呼叫 ask_session 前先用它找到對象。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ask_session',
    description:
      '把訊息送進另一個 AI 對話，等待它完成該回合後回傳它的回覆。適合請另一個 AI 審查、提供第二意見或分工。' +
      '只詢問與對方目前工作相關的對話（同資料夾或同主題，見 list_sessions）；對方正在做別的事時，無關的任務請改用 open_session 開新對話。對方可能拒絕不相關的請求。' +
      '限制：每個使用者回合只能詢問有限次數、轉介層數有上限、不可反問正在等你回覆的對話。' +
      '收到回覆後請自行整合結論，不要為了確認而反覆詢問。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'list_sessions 回傳的對話 id，例如 "s2"' },
        message: { type: 'string', description: '要給對方的完整訊息，需自帶足夠背景，對方看不到你的對話內容' },
      },
      required: ['session_id', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'open_session',
    description:
      '沒有與這項任務相關的對話可詢問時（例如現有對話都在別的資料夾做別的事），在背景開一個新的 AI 對話（與你同資料夾），之後用 ask_session 詢問它。' +
      '需使用者在設定中允許，且同時開啟的數量有上限；每個新對話都會消耗使用者的用量，先用 list_sessions 確認沒有現成對話再開。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['claude', 'codex'], description: '要開的 AI；省略時開與你不同的那一種，以取得不同模型的意見' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'add_todo',
    description:
      '記下一項你建議、但使用者這回合沒有要處理的後續事項（例如「之後可以再改 X」），存在這個資料夾的待辦清單，使用者會在 AI Tools Terminal 側邊欄看到。' +
      '一項一件事、標題簡短；使用者要你現在就做的不用記。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '簡短標題，一行內，例如「設定頁加入匯出功能」' },
        detail: { type: 'string', description: '選填：之後接手需要的背景，例如相關檔案或原因' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_todos',
    description: '列出這個資料夾還沒完成的待辦（已完成或被使用者移除的不會列出）。使用者問還有什麼要做、或你要接續之前的工作時使用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'complete_todo',
    description: '你做完某項待辦後呼叫，把它從清單移到已完成。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'list_todos 或 add_todo 回傳的 id，例如 "t3"' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
]

const INSTRUCTIONS =
  '當你建議了數項後續事項而使用者沒有要現在處理時，用 add_todo 逐項記下；做完待辦中的項目時用 complete_todo 標記完成。'

const inflight = new Map() // JSON-RPC id -> http request

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function callApp(tool, args, rpcId) {
  return new Promise(resolve => {
    if (!AITT_PORT || !AITT_SESSION) return resolve({ text: '這個對話不是由 AI Tools Terminal 開啟，無法使用協作功能。', isError: true })
    const body = JSON.stringify({ session: AITT_SESSION, tool, args })
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(AITT_PORT),
        path: '/mcp/call',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aitt-token': AITT_TOKEN || '', 'content-length': Buffer.byteLength(body) },
      },
      res => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', c => (data += c))
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { resolve({ text: 'AI Tools Terminal 回應無法解析', isError: true }) }
        })
      },
    )
    req.on('error', e => resolve({ text: `無法連線到 AI Tools Terminal：${e.message}`, isError: true }))
    inflight.set(rpcId, req)
    req.end(body)
  }).finally(() => inflight.delete(rpcId))
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'notifications/cancelled') {
    inflight.get(params?.requestId)?.destroy()
    return
  }
  if (id === undefined) return
  switch (method) {
    case 'initialize':
      return write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'aitt', version: '0.1.0' },
          instructions: INSTRUCTIONS,
        },
      })
    case 'ping':
      return write({ jsonrpc: '2.0', id, result: {} })
    case 'tools/list':
      return write({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    case 'tools/call': {
      const r = await callApp(params?.name, params?.arguments || {}, id)
      return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], isError: !!r.isError } })
    }
    default:
      return write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    handle(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
