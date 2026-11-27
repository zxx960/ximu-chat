import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { chatEndpoint } from './endpoint.mjs'
import { CHAT_SIZE_ERROR, MAX_CHAT_BYTES } from './public/attachment-limits.mjs'

const host = process.env.XIMU_CHAT_HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 4173)
const publicOrigins = new Map()
for (const value of (process.env.XIMU_CHAT_PUBLIC_ORIGIN ?? '').split(',')) {
  if (!value.trim()) continue
  const origin = new URL(value.trim())
  if (origin.protocol !== 'https:' || origin.href !== `${origin.origin}/`) {
    throw new Error('XIMU_CHAT_PUBLIC_ORIGIN 只能包含 HTTPS 源地址。')
  }
  publicOrigins.set(origin.host, origin.origin)
}
const publicDeployment = publicOrigins.size > 0
const upstreamApiUrl = process.env.XIMU_CHAT_UPSTREAM_API_URL ?? 'https://codex.ximuai.com'

if (!publicDeployment && host !== '127.0.0.1') {
  throw new Error('监听容器或服务器网络时需要设置 XIMU_CHAT_PUBLIC_ORIGIN。')
}
if (publicDeployment && new URL(upstreamApiUrl).protocol !== 'https:') {
  throw new Error('XIMU_CHAT_UPSTREAM_API_URL 必须使用 HTTPS。')
}

const allowedUpstreamEndpoints = publicDeployment ? new Set([
  chatEndpoint(upstreamApiUrl).url,
  chatEndpoint(upstreamApiUrl, true).url,
]) : null

const assets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/chat.mjs', ['public/chat.mjs', 'text/javascript; charset=utf-8']],
  ['/attachments.mjs', ['public/attachments.mjs', 'text/javascript; charset=utf-8']],
  ['/attachment-limits.mjs', ['public/attachment-limits.mjs', 'text/javascript; charset=utf-8']],
  ['/endpoint.mjs', ['endpoint.mjs', 'text/javascript; charset=utf-8']],
  ['/ximu.svg', ['public/ximu.svg', 'image/svg+xml']],
  ['/chat-logo.svg', ['public/chat-logo.svg', 'image/svg+xml']],
  ['/ximu-chat-logo.png', ['public/ximu-chat-logo.png', 'image/png']],
  ['/vendor/marked.js', ['node_modules/marked/lib/marked.esm.js', 'text/javascript; charset=utf-8']],
  ['/vendor/purify.js', ['node_modules/dompurify/dist/purify.es.mjs', 'text/javascript; charset=utf-8']],
])

class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

function sendJson(response, status, message, code) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: { message, code } }))
}

async function readJson(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > MAX_CHAT_BYTES) {
      request.resume()
      throw new HttpError(413, CHAT_SIZE_ERROR)
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size))
  } catch {
    throw new HttpError(400, '无法读取请求内容。')
  }
}

function isValidMessage(message) {
  if (!message || !['user', 'assistant'].includes(message.role)) return false
  if (typeof message.content === 'string') return true
  return message.role === 'user' && Array.isArray(message.content) && message.content.length > 0 &&
    message.content.every(part => {
      if (part?.type === 'text') return typeof part.text === 'string'
      if (part?.type === 'file') {
        const { filename, file_data: data } = part.file ?? {}
        return typeof filename === 'string' && filename.trim().length > 0 && typeof data === 'string' &&
          /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)
      }
      if (part?.type !== 'image_url') return false
      const url = part.image_url?.url
      return typeof url === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)
    })
}

function toResponsesMessage({ role, content }) {
  if (typeof content === 'string') return { role, content }
  return {
    role,
    content: content.map(part => {
      if (part.type === 'file') {
        const { filename, file_data } = part.file
        return { type: 'input_file', filename, file_data }
      }
      if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url, detail: 'auto' }
      return { type: 'input_text', text: part.text }
    }),
  }
}

async function chat(request, response) {
  const contentType = request.headers['content-type']?.split(';')[0].trim()
  if (contentType !== 'application/json') throw new HttpError(415, '需要 JSON 请求。')
  const key = request.headers.authorization?.match(/^Bearer ([!-~]+)$/)?.[1]
  if (!key) throw new HttpError(401, '请填写有效的 API Key。')

  const { url, model, messages } = (await readJson(request)) ?? {}
  if (typeof model !== 'string' || !model.trim() || !Array.isArray(messages) || !messages.length ||
      !messages.every(isValidMessage)) {
    throw new HttpError(400, '请填写模型名称和消息。')
  }

  let endpoint
  const hasFiles = messages.some(({ content }) => Array.isArray(content) && content.some(part => part.type === 'file'))
  try {
    if (typeof url !== 'string') throw new Error()
    endpoint = chatEndpoint(url, hasFiles)
  } catch {
    throw new HttpError(400, '请输入有效的 HTTP 或 HTTPS API URL。')
  }
  if (allowedUpstreamEndpoints && !allowedUpstreamEndpoints.has(endpoint.url)) {
    throw new HttpError(403, '服务器版仅支持站点配置的 API 地址，请检查连接设置。')
  }

  const disconnect = new AbortController()
  if (response.destroyed) return
  response.once('close', () => disconnect.abort())
  const { signal } = disconnect
  const body = { model: model.trim(), stream: true }
  if (endpoint.responses) {
    body.input = messages.map(toResponsesMessage)
    body.store = false
  } else {
    body.messages = messages.map(({ role, content }) => ({ role, content }))
  }

  let upstream
  try {
    upstream = await fetch(endpoint.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch {
    if (signal.aborted) return
    throw new HttpError(502, '无法连接 API，请检查 URL 和网络。')
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel()
    throw new HttpError(502, 'API 返回了重定向，请填写最终的接口地址。')
  }

  const type = upstream.headers.get('content-type') ?? ''
  const isStream = /^text\/event-stream\b/i.test(type)
  const isJson = /^application\/(?:[\w.+-]+\+)?json\b/i.test(type)
  if (!upstream.body || (!isStream && !isJson)) {
    await upstream.body?.cancel()
    if (!upstream.ok && upstream.status >= 400) {
      throw new HttpError(upstream.status, `API 返回错误（HTTP ${upstream.status}）。`)
    }
    throw new HttpError(502, 'API 返回了无法读取的内容，请检查接口地址。')
  }

  response.writeHead(upstream.status, {
    'Content-Type': isStream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders()
  await pipeline(Readable.fromWeb(upstream.body), response, { signal })
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")

  const authority = request.headers.host
  const localPort = server.address().port
  const localAuthorities = [`${host}:${localPort}`, `localhost:${localPort}`]
  const expectedOrigin = publicDeployment
    ? publicOrigins.get(authority)
    : (localAuthorities.includes(authority) ? `http://${authority}` : null)
  const blockedCrossSite = request.headers['sec-fetch-site'] === 'cross-site' &&
    (!publicDeployment || request.method === 'POST')
  if (!expectedOrigin || (request.headers.origin && request.headers.origin !== expectedOrigin) ||
      blockedCrossSite) {
    return sendJson(response, 403, '请使用此部署配置的访问地址打开西牧chat。')
  }

  try {
    const path = request.url.split('?')[0]
    if (request.method === 'POST' && path === '/api/chat') return await chat(request, response)

    const asset = assets.get(path)
    if (asset && ['GET', 'HEAD'].includes(request.method)) {
      const [file, type] = asset
      const content = await readFile(new URL(file, import.meta.url))
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length })
      return response.end(request.method === 'HEAD' ? undefined : content)
    }
    sendJson(response, 404, '页面不存在。')
  } catch (error) {
    if (response.destroyed) return
    if (response.headersSent) return response.destroy()
    if (error instanceof HttpError) return sendJson(response, error.status, error.message, error.code)
    sendJson(response, 500, '本地服务无法处理请求。')
  }
})

server.on('error', error => {
  const message = error.code === 'EADDRINUSE' ? `端口 ${port} 已占用。请设置 PORT 后重试。` : error.message
  console.error(message)
  process.exitCode = 1
})
server.listen(port, host, () => {
  console.log(`西牧chat · http://${host}:${server.address().port}`)
})
