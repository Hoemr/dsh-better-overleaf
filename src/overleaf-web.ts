/**
 * Minimal Overleaf website-endpoint client for snapshot pushes. Everything
 * here runs with the user's web session cookie (no git token needed), so
 * free accounts get two-way sync through the same endpoints the editor uses.
 *
 * Endpoints (verified against the official overleaf/overleaf router):
 * - `GET  /project/:id`                → page HTML carrying `csrfToken`
 * - `POST /project/:id/folder`         → create folder (JSON, returns the row)
 * - `POST /project/:id/upload`         → multipart upload (`qqfile`), creates
 *                                        a doc for text and a file for binary
 * - `DELETE /project/:id/doc|file/:id` → remove an entity
 * - socket.io 0.9 `joinProject`        → the folder/doc/file tree with ids
 *
 * The socket.io client below implements the minimal 0.9 wire protocol (the
 * production server runs Overleaf's own 0.9 fork): HTTP handshake for the
 * session id, one WebSocket, `5:<id>:["joinProject",{...}]` with the `6:`
 * ack. Heartbeats are answered so short sessions never get dropped.
 * @module dsh-better-overleaf/overleaf-web
 */
import { join } from 'node:path'
import WebSocket from 'ws'

/** One remote entity resolved from the project tree. */
export interface OverleafRemoteEntry {
  /** Overleaf entity id (doc, file, or folder). */
  id: string
  /** `doc` (text), `file` (binary), or `folder`. */
  type: 'doc' | 'file' | 'folder'
}

/** Flat remote tree: forward-slash path → entity. Folders included. */
export interface OverleafRemoteTree {
  rootFolderId: string
  /** `/`-separated relative path (no leading slash) → entity. */
  entries: Map<string, OverleafRemoteEntry>
}

/** Web-session credentials shared by every call. */
export interface OverleafWebSession {
  cookie: string
  /** Override for tests/self-hosted deployments; defaults to overleaf.com. */
  origin?: string
  /** CSRF token; fetched lazily from the project page when missing. */
  csrf?: string
}

/** Base Overleaf origin. */
const ORIGIN = 'https://www.overleaf.com'

/** Effective origin for one session. */
function originOf(session: OverleafWebSession): string {
  return session.origin ?? ORIGIN
}

/** Shared browser-like headers; XML header matches the editor's own fetches. */
function webHeaders(session: OverleafWebSession, csrf?: string): Record<string, string> {
  return {
    cookie: session.cookie,
    ...(csrf !== undefined ? { 'x-csrf-token': csrf } : {}),
  }
}

/** Read the CSRF token the editor page embeds for the session. */
export async function fetchCsrf(session: OverleafWebSession, signal?: AbortSignal): Promise<string> {
  const response = await fetch(`${originOf(session)}/project`, {
    headers: { ...webHeaders(session), accept: 'text/html' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`overleaf: 无法打开 Overleaf 页面读取 CSRF（HTTP ${String(response.status)}）；网页会话可能已过期，请重新登录`)
  const html = await response.text()
  const token = html.match(/csrfToken["']?\s*[:=]\s*["']([^"']+)["']/)?.[1]
    ?? html.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)"/i)?.[1]
  if (token === undefined || token === '') {
    throw new Error('overleaf: 页面里没有找到 CSRF 令牌；网页会话可能已过期，请重新登录')
  }
  return token
}

/**
 * Minimal socket.io 0.9 client: HTTP handshake → WebSocket → one emit with
 * ack. Runs on the Node global WebSocket, answers heartbeats, and closes as
 * soon as the awaited ack arrives.
 */
async function socketEmit(
  session: OverleafWebSession,
  event: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const handshake = await fetch(`${originOf(session)}/socket.io/1/?t=${String(Date.now())}`, {
    headers: webHeaders(session),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!handshake.ok) throw new Error(`overleaf: socket 握手失败（HTTP ${String(handshake.status)}）`)
  const [sid] = (await handshake.text()).split(':')
  if (sid === undefined || sid === '') throw new Error('overleaf: socket 握手响应异常')

  const wsOrigin = originOf(session).replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
  const url = `${wsOrigin}/socket.io/1/websocket/${sid}`
  return await new Promise<unknown>((resolve, reject) => {
    // `ws` (not the global WebSocket) is required: the 0.9 handshake must
    // carry the session cookie in the upgrade request headers.
    const socket = new WebSocket(url, { headers: { cookie: session.cookie } })
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* already closed */ }
      reject(new Error('overleaf: socket 等待超时'))
    }, 30_000)
    const settle = (fn: () => void): void => {
      clearTimeout(timer)
      try { socket.close() } catch { /* already closed */ }
      fn()
    }
    let messageId = 0
    socket.on('open', () => {
      messageId += 1
      socket.send(`5:${String(messageId)}:${JSON.stringify([event, payload])}`)
    })
    socket.on('message', (raw: unknown) => {
      const frame = String(raw)
      // 0.9 heartbeat: answer immediately so short sessions stay alive.
      if (frame.startsWith('2::')) {
        socket.send('2::')
        return
      }
      // Ack frame: `6:<msgId>:<json>` where the JSON is `[err, result]`.
      const ack = frame.match(/^6:(\d+):([\s\S]*)$/)
      if (ack === null) return
      if (ack[1] !== String(messageId)) return
      try {
        const parsed = JSON.parse(ack[2] ?? 'null') as [unknown, unknown]
        const [error, result] = parsed
        if (error !== null && error !== undefined) {
          settle(() => { reject(new Error(`overleaf: ${String(error)}`)) })
          return
        }
        settle(() => { resolve(result) })
      } catch (error) {
        settle(() => { reject(error instanceof Error ? error : new Error(String(error))) })
      }
    })
    socket.on('error', (error: Error) => {
      settle(() => { reject(new Error(`overleaf: socket 连接失败：${error.message}`)) })
    })
    socket.on('close', () => {
      clearTimeout(timer)
    })
  })
}

/** One node of the joinProject folder tree. */
interface OverleafFolderNode {
  _id: string
  name: string
  folders?: OverleafFolderNode[]
  docs?: Array<{ _id: string; name: string }>
  files?: Array<{ _id: string; name: string }>
}

/**
 * Fetch the project tree (root folder id + every doc/file/folder with ids)
 * through the socket.io `joinProject` broadcast the editor itself uses.
 */
export async function fetchRemoteTree(
  session: OverleafWebSession,
  projectId: string,
  signal?: AbortSignal,
): Promise<OverleafRemoteTree> {
  const project = await socketEmit(session, 'joinProject', { project_id: projectId }, signal) as {
    rootFolder?: OverleafFolderNode[]
  } | null
  const root = project?.rootFolder?.[0]
  if (root === undefined) throw new Error('overleaf: 无法读取项目文件树（joinProject 无响应）；网页会话可能已过期')
  const entries = new Map<string, OverleafRemoteEntry>()
  const walk = (nodes: OverleafFolderNode[], prefix: string): void => {
    for (const folder of nodes) {
      const path = prefix === '' ? folder.name : `${prefix}/${folder.name}`
      entries.set(path, { id: folder._id, type: 'folder' })
      walk(folder.folders ?? [], path)
      for (const doc of folder.docs ?? []) {
        entries.set(`${path}/${doc.name}`, { id: doc._id, type: 'doc' })
      }
      for (const file of folder.files ?? []) {
        entries.set(`${path}/${file.name}`, { id: file._id, type: 'file' })
      }
    }
  }
  walk(root.folders ?? [], '')
  for (const doc of root.docs ?? []) {
    entries.set(doc.name, { id: doc._id, type: 'doc' })
  }
  for (const file of root.files ?? []) {
    entries.set(file.name, { id: file._id, type: 'file' })
  }
  return { rootFolderId: root._id, entries }
}

/** Create one folder under a parent; existing names resolve to the same row. */
export async function createFolder(
  session: OverleafWebSession,
  projectId: string,
  parentFolderId: string,
  name: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${originOf(session)}/project/${projectId}/folder`, {
    method: 'POST',
    headers: { ...webHeaders(session, session.csrf), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ parent_folder_id: parentFolderId, name }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`overleaf: 建立文件夹失败（HTTP ${String(response.status)}）`)
  const folder = await response.json() as { _id?: string }
  if (folder._id === undefined) throw new Error('overleaf: 建立文件夹的响应缺少 id')
  return folder._id
}

/**
 * Upload one file into a folder. Overleaf turns text uploads into docs and
 * binary uploads into files, mirroring the editor's own upload behavior.
 */
export async function uploadEntity(
  session: OverleafWebSession,
  projectId: string,
  folderId: string,
  name: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const form = new FormData()
  form.set('qqfile', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), name)
  const query = new URLSearchParams({
    folder_id: folderId,
    _csrf: session.csrf ?? '',
    qquuid: crypto.randomUUID(),
    qqfilename: name,
    qqtotalfilesize: String(bytes.byteLength),
  })
  const response = await fetch(`${originOf(session)}/project/${projectId}/upload?${query.toString()}`, {
    method: 'POST',
    headers: webHeaders(session, session.csrf),
    body: form,
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`overleaf: 上传 ${name} 失败（HTTP ${String(response.status)}）`)
  const body = await response.json().catch(() => ({ success: true })) as { success?: boolean; error?: string }
  if (body.success === false) throw new Error(`overleaf: 上传 ${name} 被拒绝：${body.error ?? 'unknown'}`)
}

/** Delete one doc or file by id. */
export async function deleteEntity(
  session: OverleafWebSession,
  projectId: string,
  type: 'doc' | 'file',
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${originOf(session)}/project/${projectId}/${type}/${id}`, {
    method: 'DELETE',
    headers: { ...webHeaders(session, session.csrf), accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok && response.status !== 404) {
    throw new Error(`overleaf: 删除 ${type} ${id} 失败（HTTP ${String(response.status)}）`)
  }
}

/**
 * Resolve (creating as needed) the folder id for one `/`-separated directory
 * path against the remote tree. Newly created folders are added to the tree
 * so later paths in the same push reuse them.
 */
export async function ensureFolder(
  session: OverleafWebSession,
  projectId: string,
  tree: OverleafRemoteTree,
  dir: string,
  signal?: AbortSignal,
): Promise<string> {
  if (dir === '' || dir === '.') return tree.rootFolderId
  let parentId = tree.rootFolderId
  let walked = ''
  for (const segment of dir.split('/')) {
    walked = walked === '' ? segment : `${walked}/${segment}`
    const existing = tree.entries.get(walked)
    if (existing?.type === 'folder') {
      parentId = existing.id
      continue
    }
    const created = await createFolder(session, projectId, parentId, segment, signal)
    tree.entries.set(walked, { id: created, type: 'folder' })
    parentId = created
  }
  return parentId
}

/** Compute the `/`-separated Overleaf directory of one mirror-relative path. */
export function overleafDir(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? '' : normalized.slice(0, index)
}

/** Compute the base file name of one mirror-relative path. */
export function overleafName(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** Re-export so transports can build paths without importing node:path twice. */
export { join as joinPath }
