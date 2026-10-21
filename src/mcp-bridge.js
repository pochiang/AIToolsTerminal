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
]

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
