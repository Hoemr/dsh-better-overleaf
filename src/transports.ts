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
import type {
  OverleafBinding, OverleafProject, OverleafSyncDirection, OverleafSyncResult, OverleafTransportKind,
} from './types.ts'

/** Credential values resolved per operation; never cached across calls. */
export interface OverleafSession {
  /** Overleaf cookie value for API requests. */
  cookie?: string
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
    : ['-c', 'user.name=dsh-overleaf', '-c', 'user.email=dsh-overleaf@localhost']
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
 * worktree is dirty, wipe everything except `.git`, unpack the zip, and commit
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
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-overleaf-zip-'))
  const unzipDir = join(tempRoot, 'unpacked')
  try {
    const zipPath = join(tempRoot, 'snapshot.zip')
    await writeFile(zipPath, zip)
    await extractZip(zipPath, unzipDir)
    for (const entry of await readdir(binding.mirrorPath)) {
      if (entry === '.git') continue
      await rm(join(binding.mirrorPath, entry), { recursive: true, force: true })
    }
    await cp(unzipDir, binding.mirrorPath, { recursive: true })
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

  /** Pull or push one bound mirror. */
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
