export function chatEndpoint(input, hasFiles = false) {
  const url = new URL(input)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('请输入有效的 HTTP 或 HTTPS API URL。')
  }

  const path = url.pathname.replace(/\/+$/, '')
  const explicit = /\/(?:chat\/completions|responses)$/.exec(path)
  const base = explicit ? path.slice(0, explicit.index) : (path || '/v1')
  const responses = hasFiles || explicit?.[0] === '/responses'
  url.pathname = `${base}${responses ? '/responses' : '/chat/completions'}`
  return { url: url.href, responses }
}
