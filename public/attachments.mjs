import { CHAT_SIZE_ERROR, MAX_CHAT_BYTES } from './attachment-limits.mjs'

const textExtensions = 'txt md markdown csv tsv json jsonl log xml yaml yml html css js mjs cjs ts jsx tsx vue py java c cpp h cs go rs sql sh ps1'.split(' ')
const textMimeTypes = {
  md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', jsonl: 'application/jsonl', xml: 'application/xml',
  yaml: 'text/yaml', yml: 'text/yaml', html: 'text/html', css: 'text/css',
}
const fileTypes = new Map([
  ['pdf', { kind: 'document', mime: 'application/pdf' }],
  ['docx', { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
  ['png', { kind: 'image', mime: 'image/png' }],
  ['jpg', { kind: 'image', mime: 'image/jpeg' }],
  ['jpeg', { kind: 'image', mime: 'image/jpeg' }],
  ['webp', { kind: 'image', mime: 'image/webp' }],
  ...textExtensions.map(extension => [extension, { kind: 'document', mime: textMimeTypes[extension] ?? 'text/plain' }]),
])

export const acceptedFileTypes = [...fileTypes.keys()].map(extension => `.${extension}`).join(',')

export function fileType(file) {
  const extension = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase()
  return fileTypes.get(extension)
}

let openingVault

function openVault() {
  openingVault ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('ximu-chat.attachments', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('files')
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        openingVault = undefined
      }
      resolve(database)
    }
    request.onerror = () => reject(request.error)
  }).catch(error => {
    openingVault = undefined
    throw error
  })
  return openingVault
}

async function fileTransaction(mode, operation) {
  const database = await openVault()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('files', mode)
    const data = operation(transaction.objectStore('files'))
    transaction.oncomplete = () => resolve(data)
    transaction.onabort = () => reject(transaction.error)
  })
}

export async function saveFiles(files) {
  await fileTransaction('readwrite', store => {
    for (const file of files) store.put(file.data, file.id)
  })
}

export async function deleteFiles(ids) {
  if (!ids.length) return
  await fileTransaction('readwrite', store => {
    for (const id of ids) store.delete(id)
  })
}

function fileDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function messagesWithFiles(messages) {
  const files = messages.flatMap(message => message.files ?? [])
  const values = new Map()
  if (files.length) {
    let results
    try { results = await fileTransaction('readonly', store => files.map(file => store.get(file.id))) }
    catch { throw new Error('无法读取浏览器中的历史附件。') }
    files.forEach((file, index) => values.set(file.id, results[index].result))
  }

  const output = []
  let contentBytes = 0
  function checkSize(size) {
    contentBytes += size
    if (contentBytes > MAX_CHAT_BYTES) throw new Error(CHAT_SIZE_ERROR)
  }
  for (const { role, content, files: attachments } of messages) {
    checkSize(new Blob([content]).size)
    if (!attachments?.length) {
      if (content) output.push({ role, content })
      continue
    }

    const sections = [content || '请阅读附件，概述主要内容。']
    const parts = []
    const imageNames = []
    for (const file of attachments) {
      const data = values.get(file.id)
      if (typeof data === 'string') {
        checkSize(new Blob([data]).size)
        sections.push(`附件内容（${file.name}）\n${data}`)
      } else if (data instanceof Blob) {
        checkSize(4 * Math.ceil(data.size / 3))
        const url = await fileDataUrl(data)
        if (file.kind === 'image') {
          imageNames.push(file.name)
          parts.push({ type: 'image_url', image_url: { url } })
        } else {
          parts.push({ type: 'file', file: { filename: file.name, file_data: url } })
        }
      } else throw new Error(`找不到历史附件「${file.name}」，请重新添加到新对话。`)
    }
    if (imageNames.length) sections.push(`图片附件（按顺序）${imageNames.join('、')}`)
    const text = sections.join('\n\n')
    output.push({ role, content: parts.length ? [{ type: 'text', text }, ...parts] : text })
  }
  return output
}
