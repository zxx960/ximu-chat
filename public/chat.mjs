import { marked } from './vendor/marked.js'
import DOMPurify from './vendor/purify.js'
import { chatEndpoint } from './endpoint.mjs'
import { acceptedFileTypes, deleteFiles, fileType, messagesWithFiles, saveFiles } from './attachments.mjs'
import { CHAT_SIZE_ERROR, MAX_CHAT_BYTES, MAX_FILE_BYTES, MAX_MESSAGE_FILE_BYTES, MAX_MESSAGE_FILES } from './attachment-limits.mjs'

const byId = id => document.getElementById(id)
const layout = byId('layout')
const sidebar = byId('sidebar')
const history = byId('history')
const historyToggle = byId('history-toggle')
const deleteDialog = byId('delete-dialog')
const deleteDescription = byId('delete-description')
const connection = byId('connection')
const connectionToggle = byId('connection-toggle')
const scrim = byId('scrim')
const settingsForm = byId('connection-form')
const settingsStatus = byId('settings-status')
const urlInput = byId('api-url')
const keyInput = byId('api-key')
const modelInput = byId('api-model')
const chatScroll = byId('chat-scroll')
const messages = byId('messages')
const composer = byId('composer')
const prompt = byId('prompt')
const send = byId('send')
const attach = byId('attach')
const attachmentInput = byId('attachment-input')
const attachmentList = byId('draft-attachments')
const attachmentNotice = byId('attachment-notice')
const retry = byId('retry')
const smallScreen = matchMedia('(max-width: 680px)')
const drawerScreen = matchMedia('(max-width: 980px)')

const storage = {
  read(name, fallback) {
    try { return JSON.parse(localStorage.getItem(`ximu-chat.${name}`)) ?? fallback }
    catch { return fallback }
  },
  write(name, value) {
    try { localStorage.setItem(`ximu-chat.${name}`, JSON.stringify(value)); return true }
    catch { return false }
  },
}

const threads = storage.read('threads', [])
const savedId = storage.read('current', null)
let currentId = threads.some(thread => thread.id === savedId) ? savedId : null
let threadToDelete = null
let config = null
let running = null
let liveContent = null
let savingAttachments = false
const errors = new Map()
const drafts = new Map()
const attachmentDrafts = new Map()
const savedConfig = storage.read('connection', {})
urlInput.value = savedConfig.url ?? urlInput.defaultValue
keyInput.value = savedConfig.key ?? ''
modelInput.value = savedConfig.model ?? ''

function element(tag, className, content) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function makeIcon(name) {
  const namespace = 'http://www.w3.org/2000/svg'
  const icon = document.createElementNS(namespace, 'svg')
  const use = document.createElementNS(namespace, 'use')
  icon.setAttribute('class', 'icon')
  icon.setAttribute('aria-hidden', 'true')
  use.setAttribute('href', `#i-${name}`)
  icon.append(use)
  return icon
}

function fileSize(size) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function fileChip(file, onRemove) {
  const chip = element('div', 'attachment-chip')
  const label = element('span', 'attachment-name', file.name)
  label.title = file.name
  chip.append(makeIcon(file.kind === 'image' ? 'image' : 'file'), label)
  if (onRemove) {
    const remove = element('button', 'icon-button attachment-remove')
    remove.type = 'button'
    remove.setAttribute('aria-label', `移除附件：${file.name}`)
    remove.disabled = savingAttachments
    remove.append(makeIcon('close'))
    remove.addEventListener('click', onRemove)
    chip.append(element('span', 'attachment-size', fileSize(file.size)), remove)
  }
  return chip
}

function renderAttachmentDraft() {
  const draft = attachmentDrafts.get(currentId)
  attachmentList.replaceChildren()
  attachmentList.hidden = !draft?.files.length
  attachmentNotice.hidden = !draft?.notice
  attachmentNotice.textContent = draft?.notice ?? ''
  for (const file of draft?.files ?? []) {
    attachmentList.append(fileChip(file, () => {
      draft.files = draft.files.filter(item => item !== file)
      draft.notice = ''
      renderAttachmentDraft()
      updateComposer()
      attach.focus()
    }))
  }
}

function queueFiles(files) {
  if (savingAttachments || !files.length) return
  const draft = attachmentDrafts.get(currentId) ?? { files: [], notice: '' }
  attachmentDrafts.set(currentId, draft)
  draft.notice = ''
  let totalBytes = draft.files.reduce((total, file) => total + file.size, 0)
  for (const file of files) {
    if (draft.files.length >= MAX_MESSAGE_FILES) {
      draft.notice = '每条消息最多添加 5 个附件。'
      break
    }
    const type = fileType(file)
    if (!type || !file.size || file.size > MAX_FILE_BYTES || totalBytes + file.size > MAX_MESSAGE_FILE_BYTES) {
      if (!type) draft.notice = `「${file.name}」格式暂不支持，请选择 PDF、DOCX、文本或 PNG、JPG、WebP 图片。`
      else if (!file.size) draft.notice = `「${file.name}」是空文件。`
      else if (file.size > MAX_FILE_BYTES) draft.notice = `「${file.name}」超过单个附件 5 MB 的限制。`
      else draft.notice = '每条消息的附件合计最多 10 MB。'
      continue
    }
    draft.files.push({
      id: crypto.randomUUID(), name: file.name, size: file.size, kind: type.kind,
      data: file.slice(0, file.size, type.mime),
    })
    totalBytes += file.size
  }
  renderAttachmentDraft()
  updateComposer()
}

attachmentInput.accept = acceptedFileTypes
attach.addEventListener('click', () => attachmentInput.click())
attachmentInput.addEventListener('change', () => {
  queueFiles(Array.from(attachmentInput.files))
  attachmentInput.value = ''
})
composer.addEventListener('dragover', event => {
  if (!event.dataTransfer.types.includes('Files')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = savingAttachments ? 'none' : 'copy'
  composer.classList.toggle('is-dragging', !savingAttachments)
})
composer.addEventListener('dragleave', event => {
  if (!composer.contains(event.relatedTarget)) composer.classList.remove('is-dragging')
})
composer.addEventListener('drop', event => {
  if (!event.dataTransfer.types.includes('Files')) return
  event.preventDefault()
  composer.classList.remove('is-dragging')
  queueFiles(Array.from(event.dataTransfer.files))
})

function resetKeyVisibility() {
  keyInput.type = 'password'
  const toggle = byId('key-toggle')
  toggle.setAttribute('aria-pressed', 'false')
  toggle.setAttribute('aria-label', '显示 API Key')
  toggle.querySelector('use').setAttribute('href', '#i-eye')
}

function syncPanels() {
  const hasHistory = smallScreen.matches && sidebar.classList.contains('open')
  const hasSettings = drawerScreen.matches && !connection.hidden
  scrim.hidden = !hasHistory && !hasSettings
  layout.querySelector('main').inert = hasHistory || hasSettings
  sidebar.inert = hasSettings
  historyToggle.setAttribute('aria-expanded', String(hasHistory))
  connectionToggle.setAttribute('aria-expanded', String(!connection.hidden))
}

function showSettings(show, focus = false) {
  if (show) sidebar.classList.remove('open')
  if (!show) resetKeyVisibility()
  connection.hidden = !show
  syncPanels()
  if (focus) {
    const next = !show ? connectionToggle : (urlInput.value && !keyInput.value ? keyInput : urlInput)
    next.focus()
  }
}

function showHistory(show) {
  if (show) showSettings(false)
  sidebar.classList.toggle('open', show)
  syncPanels()
  if (show) byId('new-chat').focus()
}

function showSettingsStatus(message, isError = false, input) {
  settingsStatus.hidden = !message
  settingsStatus.textContent = message
  settingsStatus.classList.toggle('error', isError)
  for (const field of [urlInput, keyInput, modelInput]) field.removeAttribute('aria-invalid')
  if (input) {
    input.setAttribute('aria-invalid', 'true')
    input.focus()
  }
}

function applyConnection(settings) {
  config = settings
  byId('connection-status').textContent = settings.model
  connectionToggle.title = `当前模型：${settings.model}`
  connectionToggle.classList.add('is-configured')
}

settingsForm.addEventListener('input', () => showSettingsStatus(''))
settingsForm.addEventListener('submit', event => {
  event.preventDefault()
  const url = urlInput.value.trim()
  const key = keyInput.value.trim()
  const model = modelInput.value.trim()
  try { chatEndpoint(url) }
  catch { return showSettingsStatus('请输入有效的 HTTP 或 HTTPS API URL。', true, urlInput) }
  if (!/^[!-~]+$/.test(key)) return showSettingsStatus('请填写 API Key，内部不能有空格。', true, keyInput)
  if (!model) return showSettingsStatus('请填写模型名称。', true, modelInput)

  applyConnection({ url, key, model })
  const stored = storage.write('connection', { url: new URL(url).search ? '' : url, key, model })
  resetKeyVisibility()
  if (errors.get(currentId)?.setup) errors.delete(currentId)
  renderError()
  showSettingsStatus(stored ? '已保存，可以发送消息。' : '已应用，本次页面有效。')
  if (drawerScreen.matches) {
    showSettings(false)
    prompt.focus()
  }
})

byId('key-toggle').addEventListener('click', () => {
  if (keyInput.type === 'text') return resetKeyVisibility()
  keyInput.type = 'text'
  const toggle = byId('key-toggle')
  toggle.setAttribute('aria-pressed', 'true')
  toggle.setAttribute('aria-label', '隐藏 API Key')
  toggle.querySelector('use').setAttribute('href', '#i-eye-off')
})
connectionToggle.addEventListener('click', () => showSettings(connection.hidden, true))
byId('close-settings').addEventListener('click', () => showSettings(false, true))
historyToggle.addEventListener('click', () => showHistory(true))
function dismissDrawer() {
  if (sidebar.classList.contains('open')) {
    showHistory(false)
    historyToggle.focus()
  } else if (!connection.hidden) showSettings(false, true)
}
scrim.addEventListener('click', dismissDrawer)
document.addEventListener('keydown', event => {
  if (deleteDialog.open) return
  if (event.key === 'Escape' && (!scrim.hidden || connection.contains(document.activeElement))) dismissDrawer()
})
drawerScreen.addEventListener('change', () => showSettings(!drawerScreen.matches && !config))
smallScreen.addEventListener('change', () => showHistory(false))
if (savedConfig.url && savedConfig.key && savedConfig.model) applyConnection(savedConfig)
showSettings(!drawerScreen.matches)

function activeThread() {
  return threads.find(thread => thread.id === currentId)
}

function rememberThreads() {
  const persisted = storage.write('threads', threads)
  storage.write('current', currentId)
  if (!persisted) sidebar.querySelector('.sidebar-footer div > span').textContent = '浏览器存储已满或不可用'
}

function renderHistory() {
  history.replaceChildren()
  if (!threads.length) {
    history.append(element('p', 'history-empty', '暂无历史对话'))
    return
  }

  for (const thread of threads) {
    const entry = element('div', `history-entry${thread.id === currentId ? ' active' : ''}`)
    const select = element('button', 'history-select', thread.title)
    select.type = 'button'
    select.title = thread.title
    if (thread.id === currentId) select.setAttribute('aria-current', 'true')
    select.addEventListener('click', () => openThread(thread.id, select))

    const remove = element('button', 'icon-button history-delete')
    remove.type = 'button'
    remove.title = '删除对话'
    remove.setAttribute('aria-label', `删除对话：${thread.title}`)
    remove.setAttribute('aria-haspopup', 'dialog')
    remove.append(makeIcon('trash'))
    remove.addEventListener('click', () => {
      if (savingAttachments || threadToDelete) return
      threadToDelete = thread
      deleteDescription.textContent = `删除「${thread.title}」后，聊天记录和附件将无法恢复。`
      deleteDialog.returnValue = ''
      deleteDialog.showModal()
    })
    entry.append(select, remove)
    history.append(entry)
  }
}

deleteDialog.addEventListener('close', () => {
  const thread = threadToDelete
  threadToDelete = null
  if (deleteDialog.returnValue !== 'delete' || savingAttachments) return
  const index = threads.indexOf(thread)
  if (index === -1) return

  if (running?.id === thread.id) running.controller.abort()
  threads.splice(index, 1)
  errors.delete(thread.id)
  drafts.delete(thread.id)
  attachmentDrafts.delete(thread.id)
  if (thread.id === currentId) {
    currentId = null
    openThread(null)
  } else {
    rememberThreads()
    renderHistory()
    byId('new-chat').focus()
  }
  const fileIds = thread.messages.flatMap(message => (message.files ?? []).map(file => file.id))
  void deleteFiles(fileIds).catch(() => {
    sidebar.querySelector('.sidebar-footer div > span').textContent = '部分本地附件清理失败'
  })
})

function openThread(id, select) {
  if (savingAttachments) return
  if (id !== currentId) drafts.set(currentId, prompt.value)
  currentId = id
  prompt.value = drafts.get(id) ?? ''
  errors.delete(null)
  showHistory(false)
  rememberThreads()
  renderHistory()
  renderConversation()
  renderError()
  renderAttachmentDraft()
  updateComposer()
  scrollToBottom()
  if (smallScreen.matches || !select) prompt.focus()
  else history.querySelector('[aria-current="true"]')?.focus()
}

byId('new-chat').addEventListener('click', () => {
  if (savingAttachments) return
  if (currentId === null) prompt.value = ''
  drafts.delete(null)
  attachmentDrafts.delete(null)
  openThread(null)
})
byId('suggestions').addEventListener('click', event => {
  const button = event.target.closest('[data-prompt]')
  if (!button) return
  prompt.value = button.dataset.prompt + (prompt.value.trim() ? `\n${prompt.value}` : '\n')
  prompt.focus()
  prompt.setSelectionRange(prompt.value.length, prompt.value.length)
  updateComposer()
})

function markdown(content, text) {
  const fragment = DOMPurify.sanitize(marked.parse(text), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: ['a', 'p', 'strong', 'em', 'del', 'pre', 'code', 'br', 'hr', 'ul', 'ol', 'li', 'blockquote',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th'],
    ALLOWED_ATTR: ['href', 'class', 'start'],
  })

  for (const link of fragment.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href')
    if (!/^https?:\/\//i.test(href)) link.removeAttribute('href')
    else {
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    }
  }

  for (const pre of fragment.querySelectorAll('pre')) {
    const code = pre.querySelector('code')
    const language = code?.className.match(/(?:^|\s)language-([\w+-]+)/)?.[1] ?? '代码'
    const frame = element('div', 'code-block')
    const header = element('div', 'code-header')
    const copy = element('button', '', '复制')
    copy.type = 'button'
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent)
        copy.textContent = '已复制'
      } catch { copy.textContent = '复制失败' }
      setTimeout(() => { copy.textContent = '复制' }, 1600)
    })
    header.append(element('span', '', language), copy)
    pre.replaceWith(frame)
    frame.append(header, pre)
  }
  content.replaceChildren(fragment)
}

function makeMessage(message, isLive = false) {
  const item = element('article', `message message-${message.role}`)
  const body = element('div', 'message-body')
  const content = element('div', 'message-content')

  if (message.role === 'assistant') {
    const avatar = element('span', 'message-avatar')
    avatar.setAttribute('aria-hidden', 'true')
    avatar.append(element('span', 'logo'))
    item.append(avatar)
    body.append(element('span', 'message-label', message.model || '助手'))
    if (isLive) {
      content.classList.add('plain-text')
      content.textContent = message.content || '正在等待回复…'
      liveContent = content
    } else {
      try { markdown(content, message.content) }
      catch { content.classList.add('plain-text'); content.textContent = message.content }
    }
  } else {
    item.setAttribute('aria-label', '你的消息')
    if (message.files?.length) {
      const files = element('div', 'attachment-list message-attachments')
      files.setAttribute('aria-label', '已发送附件')
      for (const file of message.files) files.append(fileChip(file))
      body.append(files)
    }
    content.classList.add('plain-text')
    content.textContent = message.content
  }
  if (message.role === 'assistant' || message.content) body.append(content)
  if (message.status === 'stopped') body.append(element('span', 'message-status', '已停止生成'))
  if (message.status === 'interrupted') body.append(element('span', 'message-status', '回复已中断'))
  item.append(body)
  return item
}

function renderConversation() {
  const thread = activeThread()
  liveContent = null
  byId('current-title').textContent = thread?.title ?? '新建对话'
  byId('welcome').hidden = Boolean(thread)
  messages.hidden = !thread
  messages.replaceChildren()
  if (!thread) return
  for (const message of thread.messages) messages.append(makeMessage(message))
  if (running?.id === thread.id) messages.append(makeMessage(running.reply, true))
}

function renderError() {
  const error = errors.get(currentId)
  byId('chat-error').hidden = !error
  byId('chat-error-text').textContent = error?.message ?? ''
  retry.hidden = !error?.retry
  retry.disabled = Boolean(running) || savingAttachments
}

function scrollToBottom() {
  chatScroll.scrollTop = chatScroll.scrollHeight
}

function updateComposer() {
  const isGenerating = running?.id === currentId
  const files = attachmentDrafts.get(currentId)?.files ?? []
  send.disabled = running ? !isGenerating : savingAttachments || (!files.length && !prompt.value.trim())
  attach.disabled = savingAttachments
  prompt.readOnly = savingAttachments
  const label = isGenerating ? '停止生成' : (savingAttachments ? '正在保存附件' : '发送消息')
  send.title = label
  send.setAttribute('aria-label', label)
  send.querySelector('use').setAttribute('href', isGenerating ? '#i-stop' : '#i-send')
  prompt.style.height = 'auto'
  prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`
}

prompt.addEventListener('input', updateComposer)
prompt.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (!running && !send.disabled) composer.requestSubmit()
})

function responseText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(part => typeof part?.text === 'string' ? part.text : '').join('')
  return ''
}

function replyText(result) {
  if (typeof result?.output_text === 'string') return result.output_text
  if (Array.isArray(result?.output)) {
    return result.output.flatMap(item => item?.content ?? []).map(part => {
      if (part?.type === 'output_text') return part.text
      if (part?.type === 'refusal') return part.refusal
      return ''
    }).join('')
  }
  return responseText(result?.choices?.[0]?.message?.content)
}

async function readEventStream(body, append) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let data = []
  let finished = false
  let ended = false
  let receivedText = false

  function write(text) {
    if (!text) return
    receivedText = true
    append(text)
  }

  function dispatch() {
    if (!data.length) return
    const payload = data.join('\n')
    data = []
    if (payload.trim() === '[DONE]') {
      ended = true
      return
    }
    let event
    try { event = JSON.parse(payload) }
    catch { throw new Error('API 返回了无法解析的流式消息。') }
    if (event?.error || event?.type === 'error' || event?.type === 'response.failed') {
      const message = event.error?.message ?? event.response?.error?.message ?? event.message
      throw new Error(typeof message === 'string' ? message : 'API 返回了流式错误。')
    }
    if (event?.type === 'response.incomplete') throw new Error('API 提前结束了回复，已保留收到的内容。')
    if (event?.type === 'response.output_text.delta' || event?.type === 'response.refusal.delta') {
      write(typeof event.delta === 'string' ? event.delta : '')
      return
    }
    if (event?.type === 'response.completed') {
      if (!receivedText) write(replyText(event.response))
      ended = true
      return
    }
    const choice = event?.choices?.[0]
    write(responseText(choice?.delta?.content ?? choice?.message?.content))
    finished ||= Boolean(choice?.finish_reason)
  }

  function readLine(line) {
    if (!line) dispatch()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
  }

  try {
    while (!ended) {
      const chunk = await reader.read()
      if (chunk.value) buffer += chunk.value
      while (!ended) {
        const delimiter = /\r\n|\n|\r/.exec(buffer)
        if (!delimiter || (!chunk.done && delimiter[0] === '\r' && delimiter.index === buffer.length - 1)) break
        readLine(buffer.slice(0, delimiter.index))
        buffer = buffer.slice(delimiter.index + delimiter[0].length)
      }
      if (chunk.done) {
        if (buffer && !ended) readLine(buffer)
        if (!ended) dispatch()
        break
      }
    }
    if (!ended && !finished) throw new Error('连接提前结束，回复可能不完整。')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function apiError(status, payload) {
  const details = payload?.error ?? payload
  const code = details?.code ?? details?.type
  if (status === 401) return 'API Key 无效或已过期，请检查连接设置。'
  if (code === 'model_not_found' || code === 'model_not_allowed') return '模型不可用，请检查模型名称和 Key 的权限。'
  if (status === 402 || code === 'insufficient_quota' || code === 'insufficient_balance') return 'API 余额或额度不足，请到服务商查看用量。'
  if (status === 403) return '当前 API Key 没有调用该接口或模型的权限。'
  if (status === 404) return '接口或模型不存在，请检查 API URL 和模型名称。'
  if (status === 429) return '请求过于频繁或已达到限额，请稍后重试。'
  return typeof details?.message === 'string' ? details.message : `API 请求失败（HTTP ${status}）。`
}

async function requestReply(thread, settings) {
  const controller = new AbortController()
  const reply = { role: 'assistant', content: '', model: settings.model }
  running = { id: thread.id, controller, reply }
  errors.delete(thread.id)
  renderConversation()
  renderError()
  updateComposer()
  scrollToBottom()

  function append(text) {
    if (!text) return
    const isVisible = currentId === thread.id && liveContent
    const nearBottom = isVisible && chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 72
    if (isVisible) {
      if (!reply.content) liveContent.textContent = text
      else liveContent.firstChild.appendData(text)
    }
    reply.content += text
    if (nearBottom) scrollToBottom()
  }

  try {
    const messages = await messagesWithFiles(thread.messages)
    const body = JSON.stringify({ url: settings.url, model: settings.model, messages })
    if (new Blob([body]).size > MAX_CHAT_BYTES) throw new Error(CHAT_SIZE_ERROR)
    const response = await fetch('./api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.key}` },
      body,
      signal: controller.signal,
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      const error = apiError(response.status, payload)
      if ([404, 405, 415, 501].includes(response.status) && messages.some(({ content }) =>
        Array.isArray(content) && content.some(part => part.type === 'file'))) {
        throw new Error(`${error} 请确认当前 API 和模型支持通过 Responses 接口接收原文件。`)
      }
      throw new Error(error)
    }

    if (response.headers.get('content-type')?.startsWith('text/event-stream') && response.body) {
      await readEventStream(response.body, append)
    } else {
      const result = await response.json()
      if (result?.error) throw new Error(apiError(502, result))
      append(replyText(result))
      if (result?.status === 'incomplete') throw new Error('API 提前结束了回复，已保留收到的内容。')
    }
    if (!reply.content.trim()) throw new Error('模型没有返回文字，请重试或更换模型。')
  } catch (error) {
    if (controller.signal.aborted) reply.status = 'stopped'
    else if (threads.includes(thread)) {
      const detail = (error instanceof TypeError ? '连接中断，请检查本地服务和 API 网络。' : error.message)
        .replaceAll(settings.key, '[API Key]').slice(0, 260)
      reply.status = 'interrupted'
      errors.set(thread.id, { message: detail, retry: true })
    }
  } finally {
    const nearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 72
    running = null
    if (threads.includes(thread)) {
      if (reply.content.trim() || reply.status === 'stopped') thread.messages.push(reply)
      rememberThreads()
    }
    if (currentId === thread.id) {
      renderConversation()
      if (nearBottom) scrollToBottom()
    }
    renderError()
    updateComposer()
  }
}

composer.addEventListener('submit', async event => {
  event.preventDefault()
  if (running) {
    if (running.id === currentId) running.controller.abort()
    return
  }
  const content = prompt.value.trim()
  const draft = attachmentDrafts.get(currentId)
  const files = draft?.files ?? []
  if (savingAttachments || (!content && !files.length)) return
  if (!config) {
    errors.set(currentId, { message: '请先填写并保存连接设置。', setup: true })
    renderError()
    showSettings(true, true)
    return
  }

  const settings = config
  const draftId = currentId
  if (files.length) {
    savingAttachments = true
    renderAttachmentDraft()
    renderError()
    updateComposer()
    try { await saveFiles(files) }
    catch {
      draft.notice = '无法保存附件，浏览器存储可能已满或不可用。'
      return
    } finally {
      savingAttachments = false
      renderAttachmentDraft()
      renderError()
      updateComposer()
    }
  }

  let thread = activeThread()
  if (!thread) {
    drafts.delete(null)
    const title = Array.from((content || files[0].name).replace(/\s+/g, ' ')).slice(0, 26).join('')
    thread = { id: crypto.randomUUID(), title, messages: [] }
    currentId = thread.id
  } else threads.splice(threads.indexOf(thread), 1)
  threads.unshift(thread)
  const fileDetails = files.map(({ id, name, kind }) => ({ id, name, kind }))
  thread.messages.push(fileDetails.length ? { role: 'user', content, files: fileDetails } : { role: 'user', content })
  drafts.delete(currentId)
  attachmentDrafts.delete(draftId)
  prompt.value = ''
  rememberThreads()
  renderHistory()
  renderAttachmentDraft()
  void requestReply(thread, settings)
})

retry.addEventListener('click', () => {
  const thread = activeThread()
  if (!config || !thread || running || savingAttachments || !errors.get(thread.id)?.retry) return
  if (thread.messages.at(-1)?.status === 'interrupted') thread.messages.pop()
  rememberThreads()
  void requestReply(thread, config)
})

renderHistory()
renderConversation()
renderError()
updateComposer()
scrollToBottom()
