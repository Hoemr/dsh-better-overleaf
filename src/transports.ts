/**
 * Overleaf transport providers. `api` owns account-facing operations (project
 * list, cookie-authenticated zip snapshots); `git` owns two-way workspace sync
 * through Overleaf's official per-project git bridge. The host service selects
 * per operation: list/login/bind-validation always run through the API
 * transport, sync runs through the binding's transport (or git under `auto`).
 */
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BINDING_FILENAME, writeBinding } from './paths.ts'
import type {
  OverleafBinding, OverleafProject, OverleafSyncDirection, OverleafSyncResult, OverleafTransportKind,
} from './types.ts'
import {
  deleteEntity, ensureFolder, fetchCsrf, fetchRemoteTree, overleafDir, overleafName, uploadEntity,
} from './overleaf-web.ts'
import type { OverleafWebSession } from './overleaf-web.ts'

/** Credential values resolved per operation; never cached across calls. */
export interface OverleafSession {
  /** Overleaf cookie value for API requests. */
  cookie?: string
  /** Website origin override (tests / self-hosted); defaults to overleaf.com. */
  origin?: string
  /** Git-bridge credential (sent as the https password with username `git`). */
  gitToken?: string
}

/** Transport provider contract implemented by the git and API providers. */
export interface OverleafTransport {
  /** Which provider this is. */
  readonly kind: OverleafTransportKind
  /** List projects visible to the session. */
  listProjects(session: OverleafSession, signal?: AbortSignal): Promise<OverleafProject[]>
}

/** Default Overleaf web origin. */
const OVERLEAF_ORIGIN = 'https://www.overleaf.com'

/**
 * Parse the Overleaf API project list. The unofficial v2 endpoint returns a
 * top-level array; older deployments wrap it as `{ projects: [...] }`.
 * @param payload - decoded JSON body.
 * @returns normalized projects.
 */
function parseProjects(payload: unknown): OverleafProject[] {
  const source = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { projects?: unknown }).projects)
      ? (payload as { projects: unknown[] }).projects
      : undefined
  if (source === undefined) {
    throw new Error('overleaf: unexpected project-list payload')
  }
  return source.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`overleaf: project entry ${index} is not an object`)
    }
    const project = entry as Record<string, unknown>
    const id = project.id ?? project._id ?? project.project_id
    const name = project.name ?? project.title
    const updatedAt = project.updatedAt ?? project.lastUpdated ?? project.last_updated
    if (typeof id !== 'string' || typeof name !== 'string') {
      throw new Error(`overleaf: project entry ${index} must carry a string id and name`)
    }
    return {
      id,
      name,
      ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
    }
  })
}

/** Recursively search a decoded dashboard JSON value for a project array. */
function projectsFromValue(value: unknown, depth = 0): OverleafProject[] | undefined {
  if (value === null || depth > 4) return undefined
  if (Array.isArray(value)) {
    try {
      const projects = parseProjects(value)
      return projects.length === 0 ? undefined : projects
    } catch {
      return undefined
    }
  }
  if (typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['projects', 'projectList', 'project_list', 'items', 'data', 'result']) {
    const nested = record[key]
    if (nested === undefined) continue
    const found = projectsFromValue(nested, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/** Extract and parse one balanced JSON object/array following an assignment. */
function extractBalancedJson(text: string, fromIndex: number): unknown {
  const startOffset = text.slice(fromIndex).search(/[\[{]/)
  if (startOffset < 0) throw new Error('overleaf: no JSON value after assignment')
  const first = fromIndex + startOffset
  const open = text[first]
  if (open !== '{' && open !== '[') throw new Error('overleaf: assignment is not JSON')
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = first; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return JSON.parse(text.slice(first, index + 1)) as unknown
    }
  }
  throw new Error('overleaf: unterminated JSON assignment')
}

/** Decode the HTML entities a meta-attribute JSON payload carries. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** Extract the decoded `content` of the first meta tag whose attributes mention `metaName`. */
function metaContent(html: string, metaName: string): string | undefined {
  const tag = html.match(new RegExp(`<meta\\b[^>]*${metaName}[^>]*>`, 'i'))
  if (tag === null) return undefined
  const content = tag[0].match(/content=["']([^"']*)["']/i)
  return content === null ? undefined : decodeHtmlEntities(content[1] ?? '')
}

/**
 * Normalize one dashboard projects payload (a bare array or a wrapper object)
 * into active projects only — archived and trashed entries are hidden, matching
 * the dashboard's default view.
 */
function activeProjectsFromPayload(payload: unknown): OverleafProject[] | undefined {
  const source = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { projects?: unknown }).projects)
      ? (payload as { projects: unknown[] }).projects
      : undefined
  if (source === undefined) return undefined
  const active = source.filter(entry => {
    if (typeof entry !== 'object' || entry === null) return true
    const record = entry as Record<string, unknown>
    return record.archived !== true && record.trashed !== true
  })
  return parseProjects(active)
}

/** Find projects embedded in the server-rendered dashboard HTML. */
function projectsFromDashboardHtml(html: string): OverleafProject[] | undefined {
  // Current Overleaf embeds the project list in the dashboard HTML as
  // `<meta ... name="ol-prefetchedProjectsBlob" content="{totalSize,projects:[...]}">`
  // (attribute order varies; the JSON is HTML-entity-escaped).
  for (const metaName of ['ol-prefetchedProjectsBlob', 'ol-projects']) {
    const raw = metaContent(html, metaName)
    if (raw === undefined) continue
    try {
      const found = activeProjectsFromPayload(JSON.parse(raw))
      if (found !== undefined) return found
    } catch {
      // Malformed meta payload; fall through to the older shapes.
    }
  }
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const content = match[1]
    if (content === undefined) continue
    const trimmed = content.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const found = projectsFromValue(JSON.parse(trimmed))
        if (found !== undefined) return found
      } catch {
        // Not the dashboard data script; keep scanning.
      }
    }
  }
  const markers = ['window.data', 'window.projectData', 'window.__INITIAL_STATE__', 'window.overleaf']
  for (const marker of markers) {
    const markerIndex = html.indexOf(marker)
    if (markerIndex < 0) continue
    const equalsIndex = html.indexOf('=', markerIndex + marker.length)
    if (equalsIndex < 0) continue
    try {
      const found = projectsFromValue(extractBalancedJson(html, equalsIndex + 1))
      if (found !== undefined) return found
    } catch {
      // Not this assignment; try the next marker.
    }
  }
  const projects = new Map<string, OverleafProject>()
  const linkPattern = /<a\b[^>]*\bhref=["']\/project\/([0-9a-fA-F]{24})["'][^>]*>([\s\S]*?)<\/a>/gi
  for (const match of html.matchAll(linkPattern)) {
    const id = match[1]
    const rawName = match[2]
    if (id === undefined || rawName === undefined) continue
    const name = rawName
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
    if (name === '') continue
    if (!projects.has(id)) projects.set(id, { id, name })
  }
  return projects.size === 0 ? undefined : [...projects.values()]
}

/**
 * API transport: Overleaf REST calls authenticated by the Playwright-captured
 * cookie. It owns account navigation and zip snapshot pulls; push is not
 * available through the website endpoints and fails with a selection error.
 */
export class OverleafApiTransport implements OverleafTransport {
  readonly kind = 'api'

  /** @param origin - Overleaf web origin, defaulting to the production site. */
  constructor(readonly origin: string = OVERLEAF_ORIGIN) {}

  /** Fetch one resource with the session cookie. */
  private async get(path: string, accept: string, session: OverleafSession, signal?: AbortSignal): Promise<Response> {
    if (session.cookie === undefined) {
      throw new Error('overleaf: OVERLEAF_COOKIE is not configured; log in from the Overleaf tab first')
    }
    const response = await fetch(`${this.origin}${path}`, {
      headers: {
        cookie: session.cookie,
        accept,
        'x-requested-with': 'XMLHttpRequest',
        referer: `${this.origin}/project`,
      },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) {
      throw new Error(`overleaf: API ${response.status} ${response.statusText} for ${path}`)
    }
    return response
  }

  /** Fetch one JSON resource with the session cookie. */
  private async getJson(path: string, session: OverleafSession, signal?: AbortSignal): Promise<unknown> {
    return await this.get(path, 'application/json', session, signal).then(response => response.json())
  }

  /** Fetch one HTML resource with the session cookie. */
  private async getText(path: string, session: OverleafSession, signal?: AbortSignal): Promise<string> {
    return await this.get(path, 'text/html', session, signal).then(response => response.text())
  }

  /** List projects visible to the authenticated account. */
  async listProjects(session: OverleafSession, signal?: AbortSignal): Promise<OverleafProject[]> {
    const failures: string[] = []
    for (const path of ['/api/project', '/api/projects', '/api/v2/projects'] as const) {
      try {
        return parseProjects(await this.getJson(path, session, signal))
      } catch (error) {
        failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      const projects = projectsFromDashboardHtml(await this.getText('/project', session, signal))
      if (projects !== undefined) return projects
      failures.push('/project: dashboard HTML contained no project links or data')
    } catch (error) {
      failures.push(`/project: ${error instanceof Error ? error.message : String(error)}`)
    }
    throw new Error(`overleaf: project list failed (${failures.join(' | ')})`)
  }

  /**
   * Download one project snapshot as a zip archive through the website's
   * download endpoint (the same one the dashboard button uses).
   */
  async downloadZip(projectId: string, session: OverleafSession, signal?: AbortSignal): Promise<Buffer> {
    const response = await this.get(`/project/${projectId}/download/zip`, 'application/zip', session, signal)
    return Buffer.from(await response.arrayBuffer())
  }

  /**
   * Verify a candidate cookie actually authenticates before storing it.
   * `document.cookie` cannot see the httpOnly `overleaf_session2` session
   * cookie, so manually pasted values are often just anonymous crumbs; the
   * dashboard answers those with a non-200 while a real session gets the HTML.
   */
  async validateCookie(cookie: string, signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${this.origin}/project`, {
      headers: { cookie, accept: 'text/html' },
      ...(signal === undefined ? {} : { signal }),
      redirect: 'manual',
    })
    if (response.status === 200) return
    const location = response.headers.get('location') ?? ''
    throw new Error(
      `overleaf: cookie rejected by Overleaf (HTTP ${response.status}${location === '' ? '' : ` -> ${location}`}); `
      + 'it must include the httpOnly overleaf_session2 value, which document.cookie cannot read',
    )
  }
}

/** A non-zero exit reported by the git child process. */
export class GitExitError extends Error {
  /**
   * @param args - git argv (no credential values).
   * @param code - exit code.
   * @param stderr - captured stderr tail.
   */
  constructor(args: readonly string[], code: number | null, stderr: string) {
    super(`overleaf: git ${args.join(' ')} exited ${String(code)}: ${stderr.trim().slice(-400)}`)
    this.name = 'GitExitError'
  }
}

/**
 * Spawn git with stdin/stdout captured and no token in argv. Credentials ride
 * through git's environment configuration (`http.extraHeader` Basic auth), so
 * they never appear in the process list or error text.
 */
export function runGit(args: readonly string[], cwd: string, session: OverleafSession, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...(session.gitToken === undefined ? {} : {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraHeader',
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`git:${session.gitToken}`).toString('base64')}`,
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const abort = (): void => { child.kill('SIGTERM') }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => {
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (code === 0) resolve(stdout)
      else reject(new GitExitError(args, code, stderr))
    })
  })
}

/**
 * Spawn git capturing raw stdout bytes — the binary-safe variant used to read
 * blobs (`cat-file blob`) that feeds uploads back to Overleaf.
 */
export function runGitBuffer(args: readonly string[], cwd: string, session: OverleafSession, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...(session.gitToken === undefined ? {} : {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraHeader',
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`git:${session.gitToken}`).toString('base64')}`,
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const abort = (): void => { child.kill('SIGTERM') }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => {
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort)
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new GitExitError(args, code, stderr))
    })
  })
}

/** Whether the worktree has any staged or unstaged changes (untracked included). */
async function hasLocalChanges(mirrorPath: string, session: OverleafSession, signal?: AbortSignal): Promise<boolean> {
  const status = await runGit(['status', '--porcelain'], mirrorPath, session, signal)
  return status.trim() !== ''
}

/** Commit pending changes, supplying a local identity only when none exists. */
export async function commitAll(mirrorPath: string, message: string, session: OverleafSession, signal?: AbortSignal): Promise<boolean> {
  await runGit(['add', '-A'], mirrorPath, session, signal)
  const quiet = await runGit(['diff', '--cached', '--quiet'], mirrorPath, session, signal)
    .then(() => false, () => true)
  if (!quiet) return false
  const [name, email] = await Promise.all([
    runGit(['config', 'user.name'], mirrorPath, session, signal).catch(() => ''),
    runGit(['config', 'user.email'], mirrorPath, session, signal).catch(() => ''),
  ])
  const identity = name.trim() !== '' && email.trim() !== ''
    ? []
    : ['-c', 'user.name=dsh-better-overleaf', '-c', 'user.email=dsh-better-overleaf@localhost']
  await runGit([...identity, 'commit', '-m', message], mirrorPath, session, signal)
  return true
}

/**
 * Extract one zip archive into `destination` using platform tooling: PowerShell
 * `Expand-Archive` on Windows, `unzip` elsewhere. Both overwrite existing files.
 */
export async function extractZip(zipPath: string, destination: string): Promise<void> {
  if (process.platform === 'win32') {
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
    const command = `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destination)} -Force`
    await new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        stdio: 'ignore', windowsHide: true,
      })
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`overleaf: Expand-Archive exited ${String(code)}`))
      })
    })
    return
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('unzip', ['-o', zipPath, '-d', destination], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`overleaf: unzip exited ${String(code)}`))
    })
  })
}

/**
 * Replace the mirror's working tree with one remote snapshot: refuse when the
 * worktree is dirty, wipe everything except `.git` and the binding file (a
 * content refresh must never unbind the mirror), unpack the zip, and commit
 * the result so better-sidebar's history and diffs stay meaningful.
 */
export async function apiSnapshotPull(
  binding: OverleafBinding,
  zip: Buffer,
  session: OverleafSession,
  signal?: AbortSignal,
): Promise<string> {
  if (await hasLocalChanges(binding.mirrorPath, session, signal)) {
    throw new Error('overleaf: mirror has uncommitted changes; commit them first or use the git transport')
  }
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-better-overleaf-zip-'))
  const unzipDir = join(tempRoot, 'unpacked')
  try {
    const zipPath = join(tempRoot, 'snapshot.zip')
    await writeFile(zipPath, zip)
    await extractZip(zipPath, unzipDir)
    for (const entry of await readdir(binding.mirrorPath)) {
      // Keep `.git` and the binding file: wiping `.overleaf.json` here used to
      // unbind the mirror and break every later sync/compile with "not bound".
      if (entry === '.git' || entry === BINDING_FILENAME) continue
      await rm(join(binding.mirrorPath, entry), { recursive: true, force: true })
    }
    await cp(unzipDir, binding.mirrorPath, { recursive: true })
    // The zip never carries the binding file; rewrite it so a mirror whose
    // binding was lost to an older pull is healed on the next refresh.
    await writeBinding(binding)
    const committed = await commitAll(
      binding.mirrorPath,
      `Pull Overleaf snapshot (${new Date().toISOString()})`,
      session,
      signal,
    )
    return committed ? 'Snapshot pulled and committed' : 'Snapshot pulled; already up to date'
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** One local change relative to the remote snapshot base. */
interface LocalChange {
  status: 'A' | 'M' | 'D'
  path: string
}

/**
 * Parse `git diff --name-status base head` into per-file changes; renames are
 * expanded into a delete + add pair so the Overleaf application stays trivial.
 */
function parseNameStatus(output: string): LocalChange[] {
  const changes: LocalChange[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const parts = trimmed.split('\t')
    const status = parts[0]?.charAt(0)
    const path = parts[parts.length - 1]
    if (path === undefined || path === '') continue
    if (status === 'A' || status === 'M') changes.push({ status, path })
    else if (status === 'D') changes.push({ status: 'D', path })
    else if (status === 'R' || status === 'C') {
      const oldPath = parts[1]
      if (oldPath !== undefined) changes.push({ status: 'D', path: oldPath })
      changes.push({ status: 'A', path })
    }
  }
  return changes
}

/**
 * Push local work to Overleaf through the website endpoints (free accounts —
 * no git bridge token needed). The remote snapshot is pulled first and serves
 * as the comparison base, so the applied change set is exactly "what the user
 * changed since the last sync", and a confirming pull lands the result locally.
 */
export async function apiSnapshotPush(
  binding: OverleafBinding,
  transport: OverleafApiTransport,
  session: OverleafSession,
  options: { signal?: AbortSignal } = {},
): Promise<OverleafSyncResult> {
  const { signal } = options
  if (session.cookie === undefined) {
    throw new Error('overleaf: OVERLEAF_COOKIE is not configured; log in from the Overleaf tab first')
  }
  const webSession: OverleafWebSession = {
    cookie: session.cookie,
    ...(session.origin !== undefined ? { origin: session.origin } : {}),
  }
  const mirrorPath = binding.mirrorPath

  // 1. Capture the local tip, then refresh the remote snapshot: after the
  //    pull, HEAD is the remote state and the diff HEAD↔PRE is exactly the
  //    local work to apply.
  const prePull = (await runGit(['rev-parse', 'HEAD'], mirrorPath, session, signal)).trim()
  await apiSnapshotPull(binding, await transport.downloadZip(binding.projectId, session, signal), session, signal)
  const remoteHead = (await runGit(['rev-parse', 'HEAD'], mirrorPath, session, signal)).trim()

  // 2. Local change set relative to the fresh remote snapshot.
  const changes = parseNameStatus(
    await runGit(['diff', '--name-status', remoteHead, prePull], mirrorPath, session, signal),
  )

  // 3. Apply to Overleaf through the website endpoints.
  webSession.csrf = await fetchCsrf(webSession, signal)
  const tree = await fetchRemoteTree(webSession, binding.projectId, signal)
  let added = 0
  let updated = 0
  let removed = 0
  for (const change of changes) {
    const remote = tree.entries.get(change.path.replaceAll('\\', '/'))
    if (change.status === 'D') {
      if (remote !== undefined && remote.type !== 'folder') {
        await deleteEntity(webSession, binding.projectId, remote.type, remote.id, signal)
        tree.entries.delete(change.path.replaceAll('\\', '/'))
        removed += 1
      }
      continue
    }
    const bytes = await runGitBuffer(
      ['cat-file', 'blob', `${prePull}:${change.path.replaceAll('\\', '/')}`],
      mirrorPath,
      session,
      signal,
    )
    const dir = overleafDir(change.path)
    const folderId = await ensureFolder(webSession, binding.projectId, tree, dir, signal)
    if (remote !== undefined && remote.type !== 'folder') {
      // Website uploads cannot overwrite in place: remove the old entity so
      // the upload lands under the same name as a fresh doc/file.
      await deleteEntity(webSession, binding.projectId, remote.type, remote.id, signal)
      updated += 1
    } else {
      added += 1
    }
    await uploadEntity(webSession, binding.projectId, folderId, overleafName(change.path), bytes, signal)
  }

  // 4. Confirming pull so the mirror holds the final remote state.
  const confirmed = await apiSnapshotPull(
    binding,
    await transport.downloadZip(binding.projectId, session, signal),
    session,
    signal,
  )

  return {
    direction: 'push',
    projectId: binding.projectId,
    mirrorPath,
    transport: 'api',
    message: `已推送 ${String(changes.length)} 个变更（新增 ${String(added)}、更新 ${String(updated)}、删除 ${String(removed)}）到 Overleaf：${confirmed}`,
  }
}

/**
 * Git transport: Overleaf's per-project git bridge at
 * `https://git.overleaf.com/<projectId>` (two-way pull/push).
 */
export class OverleafGitTransport {
  /** Overleaf git origin, defaulting to the production bridge. */
  constructor(readonly origin: string = 'https://git.overleaf.com') {}

  /** Resolve one binding's Overleaf remote URL. */
  remote(projectId: string): string {
    return `${this.origin}/${projectId}`
  }

  /**
   * Clone one project into an empty mirror directory. Requires the git token;
   * the credential rides through the environment, never argv.
   */
  async clone(projectId: string, mirrorPath: string, session: OverleafSession, signal?: AbortSignal): Promise<string> {
    if (session.gitToken === undefined) {
      throw new Error('overleaf: OVERLEAF_GIT_TOKEN is not configured; store the Overleaf git-bridge credential first')
    }
    return await runGit(['clone', this.remote(projectId), '.'], mirrorPath, session, signal)
  }

  /**
   * Whether the mirror carries a git remote at all. API-seeded mirrors are
   * `git init` only — status/pull fall back to the snapshot transport there.
   */
  async hasRemote(mirrorPath: string, session: OverleafSession, signal?: AbortSignal): Promise<boolean> {
    const remotes = await runGit(['remote'], mirrorPath, session, signal)
    return remotes.trim() !== ''
  }

  /**
   * Read one mirror's live position relative to its remote: ahead/behind
   * counts, dirty state, and both commit timestamps. Runs `git fetch` first so
   * the numbers reflect Overleaf right now.
   */
  async readStatus(
    binding: OverleafBinding,
    session: OverleafSession,
    signal?: AbortSignal,
  ): Promise<{
    branch: string
    ahead: number
    behind: number
    diverged: boolean
    dirty: boolean
    dirtyCount: number
    remoteCommitTime?: string
    localCommitTime?: string
  }> {
    if (session.gitToken === undefined) {
      throw new Error('overleaf: OVERLEAF_GIT_TOKEN is not configured; store the Overleaf git-bridge credential first')
    }
    if (!(await this.hasRemote(binding.mirrorPath, session, signal))) {
      throw new Error('overleaf: mirror has no git remote (API-seeded snapshot); configure the git transport to read remote status')
    }
    await runGit(['fetch', 'origin', '--prune'], binding.mirrorPath, session, signal)
    const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], binding.mirrorPath, session, signal)).trim()
    const counts = (await runGit(
      ['rev-list', '--left-right', '--count', `HEAD...origin/${branch}`],
      binding.mirrorPath,
      session,
      signal,
    )).trim()
    const [aheadText, behindText] = counts.split('\t')
    const ahead = Number.parseInt(aheadText ?? '0', 10) || 0
    const behind = Number.parseInt(behindText ?? '0', 10) || 0
    const statusOutput = await runGit(['status', '--porcelain'], binding.mirrorPath, session, signal)
    const dirtyLines = statusOutput.split('\n').filter(line => line.trim() !== '')
    const [remoteCommitTime, localCommitTime] = await Promise.all([
      runGit(['log', '-1', '--format=%cI', `origin/${branch}`], binding.mirrorPath, session, signal)
        .then(out => out.trim(), () => undefined),
      runGit(['log', '-1', '--format=%cI', 'HEAD'], binding.mirrorPath, session, signal)
        .then(out => out.trim(), () => undefined),
    ])
    return {
      branch,
      ahead,
      behind,
      diverged: ahead > 0 && behind > 0,
      dirty: dirtyLines.length > 0,
      dirtyCount: dirtyLines.length,
      ...(remoteCommitTime !== undefined && remoteCommitTime !== '' ? { remoteCommitTime } : {}),
      ...(localCommitTime !== undefined && localCommitTime !== '' ? { localCommitTime } : {}),
    }
  }

  /**
   * List the files a stopped rebase left conflicted, before rolling the rebase
   * back so the mirror stays on its pre-pull commit.
   */
  private async conflictedFiles(mirrorPath: string, session: OverleafSession, signal?: AbortSignal): Promise<string[]> {
    const output = await runGit(
      ['diff', '--name-only', '--diff-filter=U'],
      mirrorPath,
      session,
      signal,
    ).catch(() => '')
    return output.split('\n').map(line => line.trim()).filter(line => line !== '')
  }

  /**
   * Smart pull with rebase semantics: pending local edits are auto-committed
   * (opt-out), a clean fast-forward is preferred, local commits are rebased on
   * the remote, and conflicts abort cleanly with the file list reported.
   */
  async smartPull(
    binding: OverleafBinding,
    session: OverleafSession,
    options: { autoCommit?: boolean; signal?: AbortSignal } = {},
  ): Promise<OverleafSyncResult> {
    if (session.gitToken === undefined) {
      throw new Error('overleaf: OVERLEAF_GIT_TOKEN is not configured; store the Overleaf git-bridge credential first')
    }
    const { autoCommit = true, signal } = options
    const committedLocally = autoCommit
      ? await commitAll(binding.mirrorPath, `同步本地修改 (${new Date().toISOString()})`, session, signal)
      : false
    const status = await this.readStatus(binding, session, signal)
    if (status.behind === 0) {
      return {
        direction: 'pull',
        projectId: binding.projectId,
        mirrorPath: binding.mirrorPath,
        transport: 'git',
        message: status.ahead > 0
          ? '远端没有新提交；本地修改待推送'
          : '已是最新，远端没有新提交',
        ...(committedLocally ? { committedLocally } : {}),
        ahead: status.ahead,
        behind: 0,
      }
    }
    if (!status.diverged) {
      const output = await runGit(
        ['merge', '--ff-only', `origin/${status.branch}`],
        binding.mirrorPath,
        session,
        signal,
      )
      return {
        direction: 'pull',
        projectId: binding.projectId,
        mirrorPath: binding.mirrorPath,
        transport: 'git',
        message: `已快进 ${String(status.behind)} 个提交：${output.trim().split('\n').slice(-1)[0]?.trim() || 'done'}`,
        ...(committedLocally ? { committedLocally } : {}),
        ahead: status.ahead,
        behind: 0,
      }
    }
    try {
      await runGit(['rebase', `origin/${status.branch}`], binding.mirrorPath, session, signal)
    } catch (error) {
      const conflictFiles = await this.conflictedFiles(binding.mirrorPath, session, signal)
      await runGit(['rebase', '--abort'], binding.mirrorPath, session, signal).catch(() => undefined)
      const detail = conflictFiles.length > 0 ? `冲突文件：${conflictFiles.join('、')}` : '存在无法自动解决的冲突'
      throw new Error(`overleaf: 拉取时遇到冲突，已中止并保留本地状态；${detail}`)
    }
    return {
      direction: 'pull',
      projectId: binding.projectId,
      mirrorPath: binding.mirrorPath,
      transport: 'git',
      message: `已变基到远端：拉取 ${String(status.behind)} 个提交，保留本地 ${String(status.ahead)} 个提交`,
      ...(committedLocally ? { committedLocally } : {}),
      ahead: 0,
      behind: 0,
    }
  }

  /**
   * Push pending local work: auto-commit first (opt-out), then refuse politely
   * when the remote moved (the caller should pull first) — Overleaf's bridge
   * rejects non-fast-forward pushes anyway.
   */
  async smartPush(
    binding: OverleafBinding,
    session: OverleafSession,
    options: { autoCommit?: boolean; signal?: AbortSignal } = {},
  ): Promise<OverleafSyncResult> {
    if (session.gitToken === undefined) {
      throw new Error('overleaf: OVERLEAF_GIT_TOKEN is not configured; store the Overleaf git-bridge credential first')
    }
    const { autoCommit = true, signal } = options
    const committedLocally = autoCommit
      ? await commitAll(binding.mirrorPath, `同步本地修改 (${new Date().toISOString()})`, session, signal)
      : false
    const status = await this.readStatus(binding, session, signal)
    if (status.behind > 0) {
      throw new Error(
        `overleaf: 远端有 ${String(status.behind)} 个新提交，请先「拉取更新」再推送，以免覆盖他人修改`,
      )
    }
    if (status.ahead === 0 && !committedLocally) {
      return {
        direction: 'push',
        projectId: binding.projectId,
        mirrorPath: binding.mirrorPath,
        transport: 'git',
        message: '没有待推送的修改，本地与远端一致',
        ahead: 0,
        behind: 0,
      }
    }
    const output = await runGit(['push', 'origin', `HEAD:refs/heads/${status.branch}`], binding.mirrorPath, session, signal)
    return {
      direction: 'push',
      projectId: binding.projectId,
      mirrorPath: binding.mirrorPath,
      transport: 'git',
      message: output.trim().split('\n').slice(-1)[0]?.trim() || `已推送 ${String(status.ahead)} 个提交到 Overleaf`,
      ...(committedLocally ? { committedLocally } : {}),
      ahead: 0,
      behind: 0,
    }
  }

  /** Legacy direct pull/push kept for the wire contract and tests. */
  async sync(
    binding: OverleafBinding,
    direction: OverleafSyncDirection,
    session: OverleafSession,
    signal?: AbortSignal,
  ): Promise<OverleafSyncResult> {
    if (session.gitToken === undefined) {
      throw new Error('overleaf: OVERLEAF_GIT_TOKEN is not configured; store the Overleaf git-bridge credential first')
    }
    const command = direction === 'pull'
      ? ['pull', '--ff-only', this.remote(binding.projectId)] as const
      : ['push', this.remote(binding.projectId), 'HEAD'] as const
    const output = await runGit([...command], binding.mirrorPath, session, signal)
    return {
      direction,
      projectId: binding.projectId,
      mirrorPath: binding.mirrorPath,
      transport: 'git',
      message: output.trim().slice(-200) || `${direction} complete`,
    }
  }
}

/** Read a file's full bytes; used by tests and the host service for zips. */
export async function readZipFile(path: string): Promise<Buffer> {
  return await readFile(path)
}
