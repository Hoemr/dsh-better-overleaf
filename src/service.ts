/**
 * dsh-better-overleaf host plugin. Exported as a Cordis Service class (the loader
 * instantiates default service classes), so mounting the row provides
 * `ctx.overleaf` and registers the /overleaf routes.
 *
 * Model: each bound project is mirrored into `<workspace>/overleaf/<name>/` as
 * a real git repository, so dsh-better-sidebar's explorer, editor, previewers,
 * and Git panel operate on Overleaf content directly. Sync runs through the
 * official git bridge (`git`) or cookie-authenticated website snapshots
 * (`api`, pull-only); `auto` prefers git when a git credential is stored.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { OVERLEAF_COOKIE, OVERLEAF_GIT_TOKEN } from './credentials.ts'
import { compileMirror, hasLatexmk } from './compile.ts'
import { loginWithPlaywright } from './login-cdp.ts'
import type { LoginProfileMode, OverleafBrowserChannel } from './login-cdp.ts'
import { allocateMirrorDir, isClaimableMirror, listWorkspaceBindings, readBinding, removeBinding, safeMirrorName, writeBinding } from './paths.ts'
import {
  loadRegistry, markSynced, removeRegistryBinding, savePolicy, upsertRegistryBinding,
} from './registry.ts'
import {
  OverleafApiTransport, OverleafGitTransport, apiSnapshotPull, apiSnapshotPush, commitAll, extractZip, runGit,
} from './transports.ts'
import type { OverleafSession } from './transports.ts'
import { registerOverleafTools } from './tools.ts'
import type {
  OverleafAutoSyncPolicy, OverleafBinding, OverleafCompileResult, OverleafLoginResult, OverleafProject,
  OverleafRemoteStatus, OverleafStatus, OverleafSyncDirection, OverleafSyncResult, OverleafTransportKind,
  OverleafWireResponse,
} from './types.ts'
import { AUTO_PULL_INTERVAL_MS } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'overleaf'

/** Services required before the host plugin can mount. */
export const inject = ['webServer', 'credentials']

/** Host plugin config; every field has a deployment-overridable default. */
export interface Config {
  /** Default transport when a binding says `auto`: git needs a stored credential. */
  transport?: OverleafTransportKind | 'auto'
  /** Overleaf web origin used by the API transport. */
  baseUrl?: string
  /** Overleaf git-bridge origin used by the git transport. */
  gitOrigin?: string
  /** Login page URL. */
  loginUrl?: string
  /** Project URL prefix proving the browser login succeeded. */
  projectUrlPrefix?: string
  /** Browser selection for the login window. */
  browserChannel?: OverleafBrowserChannel
  /** Explicit Chromium-family executable tried first (third-party browsers). */
  browserPath?: string
  /** Launch the login browser headless; false is the interactive desktop choice. */
  playwrightHeadless?: boolean
  /** Login wait timeout in milliseconds. */
  loginTimeoutMs?: number
  /** Login profile persistence: persistent (default) remembers the session across logins. */
  loginProfile?: LoginProfileMode
}

/** Default Overleaf production endpoints. */
const DEFAULT_BASE_URL = 'https://www.overleaf.com'
const DEFAULT_GIT_ORIGIN = 'https://git.overleaf.com'
const DEFAULT_LOGIN_URL = 'https://www.overleaf.com/login'
const DEFAULT_PROJECT_URL_PREFIX = 'https://www.overleaf.com/project'
const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000

/** Parsed config with every default applied. */
interface ResolvedConfig {
  transport: OverleafTransportKind | 'auto'
  baseUrl: string
  gitOrigin: string
  loginUrl: string
  projectUrlPrefix: string
  browserChannel: OverleafBrowserChannel
  browserPath?: string
  playwrightHeadless: boolean
  loginTimeoutMs: number
  loginProfile: LoginProfileMode
}

export const Config: z<Config> = z.object({
  transport: z.union([z.const('auto'), z.const('git'), z.const('api')]).default('auto'),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  gitOrigin: z.string().default(DEFAULT_GIT_ORIGIN),
  loginUrl: z.string().default(DEFAULT_LOGIN_URL),
  projectUrlPrefix: z.string().default(DEFAULT_PROJECT_URL_PREFIX),
  browserChannel: z.union([z.const('auto'), z.const('default'), z.const('msedge'), z.const('chrome'), z.const('real')]).default('auto'),
  browserPath: z.string(),
  playwrightHeadless: z.boolean().default(false),
  loginTimeoutMs: z.natural().default(DEFAULT_LOGIN_TIMEOUT_MS),
  loginProfile: z.union([z.const('persistent'), z.const('temporary')]).default('persistent'),
})

/** Apply defaults in the owning implementation, never hidden inside a method. */
function resolveConfig(config: Config): ResolvedConfig {
  return {
    transport: config.transport ?? 'auto',
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    gitOrigin: config.gitOrigin ?? DEFAULT_GIT_ORIGIN,
    loginUrl: config.loginUrl ?? DEFAULT_LOGIN_URL,
    projectUrlPrefix: config.projectUrlPrefix ?? DEFAULT_PROJECT_URL_PREFIX,
    browserChannel: config.browserChannel ?? 'auto',
    ...(config.browserPath !== undefined && config.browserPath.trim() !== '' ? { browserPath: config.browserPath.trim() } : {}),
    playwrightHeadless: config.playwrightHeadless ?? false,
    loginTimeoutMs: config.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    loginProfile: config.loginProfile ?? 'persistent',
  }
}

/** Route-level JSON request ceiling; login and sync payloads are small. */
const MAX_REQUEST_BYTES = 64 * 1024

/** Loopback literals the host routes accept. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Reject remote browsers before a host mutation route reads its payload. */
function isLoopback(req: IncomingMessage): boolean {
  return req.socket.remoteAddress === undefined || LOOPBACK_ADDRESSES.has(req.socket.remoteAddress)
}

/** Read a bounded JSON request body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    bytes += buffer.byteLength
    if (bytes > MAX_REQUEST_BYTES) throw new Error('overleaf: request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** Write one wire envelope and end the response. */
function sendJson(res: ServerResponse, status: number, body: OverleafWireResponse<unknown>): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Send one route failure as the shared wire error envelope. */
function sendError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof Error && error.name !== 'Error' ? error.name : 'overleaf-route-error'
  sendJson(res, 500, { ok: false, error: { code, message } })
}

/** Extract one optional string field from an unknown route payload. */
function stringField(payload: unknown, field: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Overleaf account/binding/sync service provided by this host plugin. */
    overleaf: OverleafService
  }
}

/** The `ctx.overleaf` service: account operations, mirrors, and sync dispatch. */
export class OverleafService extends Service {
  static inject = ['webServer', 'credentials']
  static Config = Config

  private readonly config: ResolvedConfig
  private readonly api: OverleafApiTransport
  private readonly git: OverleafGitTransport
  /** Mirrors currently mid-sync, keyed by path (background + foreground interlock). */
  private readonly syncInFlight = new Set<string>()
  /** Auto-sync timer, rescheduled whenever the policy changes. */
  private autoSyncTimer: NodeJS.Timeout | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'overleaf')
    this.config = resolveConfig(config)
    this.api = new OverleafApiTransport(this.config.baseUrl)
    this.git = new OverleafGitTransport(this.config.gitOrigin)
    this.registerRoutes()
    registerOverleafTools(ctx, this)
    ctx.effect(() => {
      void this.rescheduleAutoSync()
      return (): void => {
        if (this.autoSyncTimer !== undefined) clearTimeout(this.autoSyncTimer)
      }
    }, 'dsh-better-overleaf: auto-sync scheduler')
  }

  /** Register one exact JSON route with the shared envelope contract. */
  private route(path: string, run: (payload: Record<string, unknown>) => Promise<unknown>): void {
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          sendJson(res, 403, { ok: false, error: { code: 'overleaf-loopback-only', message: 'overleaf routes are loopback-only' } })
          return
        }
        try {
          const payload = await readJsonBody(req)
          sendJson(res, 200, { ok: true, value: await run((payload ?? {}) as Record<string, unknown>) })
        } catch (error) {
          sendError(res, error)
        }
      },
    }), `dsh-better-overleaf: route ${path}`)
  }

  private registerRoutes(): void {
    this.route('/overleaf/status', payload => this.status(stringField(payload, 'workspacePath')))
    this.route('/overleaf/projects', () => this.listProjects())
    this.route('/overleaf/bindings', async (payload) => {
      const workspacePath = stringField(payload, 'workspacePath')
      if (workspacePath === undefined || !isAbsolute(workspacePath)) {
        throw new Error('overleaf: bindings requires an absolute workspacePath')
      }
      return { workspacePath, bindings: await listWorkspaceBindings(workspacePath) }
    })
    this.route('/overleaf/login', (payload) => {
      const browserChannel = stringField(payload, 'browserChannel')
      const channel: OverleafBrowserChannel | undefined =
        browserChannel === 'msedge' || browserChannel === 'chrome' || browserChannel === 'auto'
          || browserChannel === 'default' || browserChannel === 'real'
          ? browserChannel
          : undefined
      return this.login(channel, stringField(payload, 'browserPath'))
    })
    this.route('/overleaf/cookie', (payload) => {
      const cookie = stringField(payload, 'cookie')
      if (cookie === undefined) throw new Error('overleaf: cookie route requires cookie')
      return this.saveCookie(cookie)
    })
    this.route('/overleaf/git-token', (payload) => {
      const token = stringField(payload, 'token')
      if (token === undefined) throw new Error('overleaf: git-token route requires token')
      return this.saveGitToken(token)
    })
    this.route('/overleaf/bind', payload => this.bind({
      workspacePath: stringField(payload, 'workspacePath'),
      projectId: stringField(payload, 'projectId'),
      transport: stringField(payload, 'transport'),
      name: stringField(payload, 'name'),
    }))
    this.route('/overleaf/unbind', (payload) => {
      const mirrorPath = stringField(payload, 'mirrorPath')
      if (mirrorPath === undefined) throw new Error('overleaf: unbind requires mirrorPath')
      return removeBinding(mirrorPath)
    })
    this.route('/overleaf/sync', (payload) => {
      const mirrorPath = stringField(payload, 'mirrorPath')
      const direction = stringField(payload, 'direction')
      if (mirrorPath === undefined || (direction !== 'pull' && direction !== 'push')) {
        throw new Error('overleaf: sync requires mirrorPath and direction "pull" | "push"')
      }
      return this.sync(mirrorPath, direction)
    })
    this.route('/overleaf/remote-status', (payload) => {
      const mirrorPath = stringField(payload, 'mirrorPath')
      if (mirrorPath === undefined) throw new Error('overleaf: remote-status requires mirrorPath')
      return this.remoteStatus(mirrorPath)
    })
    this.route('/overleaf/compile', (payload) => {
      const mirrorPath = stringField(payload, 'mirrorPath')
      if (mirrorPath === undefined) throw new Error('overleaf: compile requires mirrorPath')
      return this.compile(mirrorPath)
    })
    this.route('/overleaf/latexmk', async () => ({ available: await hasLatexmk() }))
    this.route('/overleaf/upgrade-transport', (payload) => {
      const mirrorPath = stringField(payload, 'mirrorPath')
      if (mirrorPath === undefined) throw new Error('overleaf: upgrade-transport requires mirrorPath')
      return this.upgradeToGit(mirrorPath)
    })
    this.route('/overleaf/auto-sync', () => this.getAutoSync())
    this.route('/overleaf/auto-sync/set', (payload) => {
      const raw = typeof payload === 'object' && payload !== null ? (payload as { policy?: unknown }).policy : undefined
      if (typeof raw !== 'object' || raw === null) throw new Error('overleaf: auto-sync/set requires policy')
      const candidate = raw as Partial<OverleafAutoSyncPolicy>
      const interval = candidate.autoPullInterval
      if (interval !== 'off' && interval !== '5m' && interval !== '15m' && interval !== '30m' && interval !== '1h') {
        throw new Error('overleaf: autoPullInterval must be one of off | 5m | 15m | 30m | 1h')
      }
      return this.setAutoSync({
        autoPullInterval: interval,
        autoPush: candidate.autoPush === true,
        autoCommitLocal: candidate.autoCommitLocal !== false,
      })
    })
  }

  /** Read the current account state plus one workspace's known mirrors. */
  async status(workspacePath?: string): Promise<OverleafStatus & { bindings?: Awaited<ReturnType<typeof listWorkspaceBindings>> }> {
    const [cookie, gitToken] = await Promise.all([
      this.ctx.credentials.describe(OVERLEAF_COOKIE),
      this.ctx.credentials.describe(OVERLEAF_GIT_TOKEN),
    ])
    const status: OverleafStatus & { bindings?: Awaited<ReturnType<typeof listWorkspaceBindings>> } = {
      loggedIn: cookie.configured,
      gitConfigured: gitToken.configured,
      transport: this.config.transport,
    }
    if (workspacePath !== undefined && isAbsolute(workspacePath)) {
      status.bindings = await listWorkspaceBindings(workspacePath)
    }
    return status
  }

  /** Resolve one credential value, throwing the tab-facing missing message. */
  private async resolveCredential(ref: CredentialRef): Promise<string> {
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved === undefined) throw new Error(`overleaf: ${String(ref)} is not configured`)
    return resolved.value
  }

  /** Resolve the transport session for one operation kind. */
  private async sessionFor(kind: OverleafTransportKind): Promise<OverleafSession> {
    if (kind === 'api') return { cookie: await this.resolveCredential(OVERLEAF_COOKIE) }
    return { gitToken: await this.resolveCredential(OVERLEAF_GIT_TOKEN) }
  }

  /** List Overleaf projects through the API transport. */
  async listProjects(signal?: AbortSignal): Promise<OverleafProject[]> {
    return await this.api.listProjects(await this.sessionFor('api'), signal)
  }

  /** Log in through direct CDP and store the captured Overleaf cookie. */
  async login(browserChannel?: OverleafBrowserChannel, browserPath?: string): Promise<OverleafLoginResult> {
    return await loginWithPlaywright(this.ctx.credentials, {
      loginUrl: this.config.loginUrl,
      projectUrlPrefix: this.config.projectUrlPrefix,
      browserChannel: browserChannel ?? this.config.browserChannel,
      ...(browserPath !== undefined && browserPath.trim() !== '' ? { browserPath: browserPath.trim() } : this.config.browserPath !== undefined ? { browserPath: this.config.browserPath } : {}),
      headless: this.config.playwrightHeadless,
      timeoutMs: this.config.loginTimeoutMs,
      profileMode: this.config.loginProfile,
    })
  }

  /** Store a cookie value only after Overleaf accepts it as a real session. */
  async saveCookie(cookie: string): Promise<void> {
    if (cookie.trim() === '') throw new Error('overleaf: cookie must not be empty')
    const value = cookie.trim()
    await this.api.validateCookie(value)
    await this.ctx.credentials.set(OVERLEAF_COOKIE, value)
  }

  /**
   * Store the git-bridge credential (account password, or the Git-integration
   * token for SSO accounts) used as the https password with username `git`.
   */
  async saveGitToken(token: string): Promise<void> {
    if (token.trim() === '') throw new Error('overleaf: git token must not be empty')
    await this.ctx.credentials.set(OVERLEAF_GIT_TOKEN, token.trim())
  }

  /**
   * Bind one workspace to one Overleaf project by creating a mirror under
   * `<workspace>/overleaf/<name>/` and seeding it (git clone, or an API zip
   * snapshot committed as the initial revision).
   */
  async bind(input: {
    workspacePath?: string | undefined
    projectId?: string | undefined
    transport?: string | undefined
    name?: string | undefined
  }): Promise<OverleafBinding> {
    const { workspacePath, projectId } = input
    if (workspacePath === undefined || !isAbsolute(workspacePath)) {
      throw new Error('overleaf: bind requires an absolute workspacePath')
    }
    if (projectId === undefined || projectId.length === 0) {
      throw new Error('overleaf: bind requires projectId')
    }
    // Visibility validation needs the web session; token-only setups skip it —
    // a wrong id simply fails at clone time with the git bridge's own error.
    const cookieConfigured = await this.ctx.credentials.describe(OVERLEAF_COOKIE)
      .then(described => described.configured, () => false)
    let projectName = input.name?.trim() !== '' && input.name !== undefined ? input.name.trim() : projectId
    if (cookieConfigured) {
      const projects = await this.listProjects()
      const project = projects.find(candidate => candidate.id === projectId)
      if (project === undefined) {
        throw new Error(`overleaf: project "${projectId}" is not visible to the logged-in account`)
      }
      projectName = project.name
    }
    const requested = input.transport === 'git' || input.transport === 'api' ? input.transport : this.config.transport
    // Claim semantics: when a directory with this name already exists and is a
    // git repository, adopt it instead of allocating a fresh mirror. This is
    // how a mirror whose binding file was lost (older snapshot pulls wiped it)
    // is re-bound without duplicating or touching its files.
    const desiredName = input.name?.trim() !== '' && input.name !== undefined ? input.name.trim() : safeMirrorName(projectName, projectId)
    const existingDir = join(workspacePath, 'overleaf', desiredName)
    if (await isClaimableMirror(existingDir)) {
      const binding: OverleafBinding = {
        projectId,
        projectName,
        mirrorPath: existingDir,
        transport: input.transport === 'git' || input.transport === 'api' || input.transport === 'auto' ? input.transport : 'auto',
      }
      await writeBinding(binding)
      await upsertRegistryBinding({ projectId, projectName, mirrorPath: existingDir, workspacePath }).catch(() => undefined)
      return binding
    }
    const mirrorPath = await allocateMirrorDir(workspacePath, desiredName)
    const binding: OverleafBinding = {
      projectId,
      projectName,
      mirrorPath,
      transport: input.transport === 'git' || input.transport === 'api' || input.transport === 'auto' ? input.transport : 'auto',
    }
    const kind = await this.seedTransport(requested)
    try {
      if (kind === 'git') {
        await this.git.clone(projectId, mirrorPath, await this.sessionFor('git'))
      } else {
        await this.seedApiMirror(projectId, mirrorPath)
      }
    } catch (error) {
      // Leave no half-seeded mirror directory behind.
      await rm(mirrorPath, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    await writeBinding(binding)
    // Index the mirror for the background auto-sync scheduler (registry is
    // best-effort: a failed write only disables auto-sync, never the bind).
    await upsertRegistryBinding({
      projectId,
      projectName,
      mirrorPath,
      workspacePath,
    }).catch(() => undefined)
    return binding
  }

  /**
   * Resolve the transport for seeding one mirror, degrading git→api when no
   * git credential is stored but a cookie is (same policy as pull sync).
   */
  private async seedTransport(requested: OverleafTransportKind | 'auto'): Promise<OverleafTransportKind> {
    if (this.effectiveTransport(requested) === 'git') {
      const gitToken = await this.ctx.credentials.describe(OVERLEAF_GIT_TOKEN)
      if (gitToken.configured) return 'git'
      const cookie = await this.ctx.credentials.describe(OVERLEAF_COOKIE)
      if (cookie.configured) return 'api'
    }
    return this.effectiveTransport(requested)
  }

  /** Seed an empty mirror directory from one API zip snapshot + initial commit. */
  private async seedApiMirror(projectId: string, mirrorPath: string): Promise<void> {
    const session = await this.sessionFor('api')
    const zip = await this.api.downloadZip(projectId, session)
    const tempDir = await mkdtemp(join(tmpdir(), 'dsh-better-overleaf-bind-'))
    const zipPath = join(tempDir, 'snapshot.zip')
    try {
      await writeFile(zipPath, zip)
      await extractZip(zipPath, mirrorPath)
      await runGit(['init'], mirrorPath, session)
      await commitAll(mirrorPath, `Initial Overleaf snapshot (${new Date().toISOString()})`, session)
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Remove one mirror's binding file; the files themselves stay on disk. */
  async unbind(mirrorPath: string): Promise<boolean> {
    const removed = await removeBinding(mirrorPath)
    if (removed) await removeRegistryBinding(mirrorPath).catch(() => undefined)
    return removed
  }

  /** Resolve the effective sync transport for one binding. */
  private effectiveTransport(requested: OverleafTransportKind | 'auto'): OverleafTransportKind {
    if (requested !== 'auto') return requested
    return this.config.transport === 'api' ? 'api' : 'git'
  }

  /**
   * Pick the sync transport for one operation, degrading git→api on a missing
   * git credential: pulls fall back to zip snapshots and pushes to the website
   * upload endpoints, so free accounts get full two-way sync.
   */
  private async syncTransport(binding: OverleafBinding, direction: OverleafSyncDirection): Promise<OverleafTransportKind> {
    const kind = this.effectiveTransport(binding.transport)
    if (kind === 'git') {
      const gitToken = await this.ctx.credentials.describe(OVERLEAF_GIT_TOKEN)
      if (gitToken.configured) return 'git'
      const cookie = await this.ctx.credentials.describe(OVERLEAF_COOKIE)
      if (cookie.configured) return 'api'
      throw new Error(direction === 'push'
        ? 'overleaf: 尚未配置任何凭据；请先登录 Overleaf（快照推送）或配置 Git 令牌（Git 双向）'
        : 'overleaf: OVERLEAF_GIT_TOKEN is not configured and no web session is available; log in or store the git-bridge credential first')
    }
    return 'api'
  }

  /** Sync one bound mirror in the requested direction (rebase-style pull, guarded push). */
  async sync(mirrorPath: string, direction: OverleafSyncDirection, signal?: AbortSignal): Promise<OverleafSyncResult> {
    const binding = await readBinding(mirrorPath)
    if (binding === undefined) throw new Error('overleaf: directory is not bound; bind a project first')
    const kind = await this.syncTransport(binding, direction)
    if (this.syncInFlight.has(mirrorPath)) {
      throw new Error('overleaf: 该镜像正在同步中，请稍后再试')
    }
    this.syncInFlight.add(mirrorPath)
    try {
      const autoCommit = (await this.getAutoSync()).autoCommitLocal
      const result = kind === 'git'
        ? direction === 'pull'
          ? await this.git.smartPull(binding, await this.sessionFor('git'), {
              autoCommit,
              ...(signal !== undefined ? { signal } : {}),
            })
          : await this.git.smartPush(binding, await this.sessionFor('git'), {
              autoCommit,
              ...(signal !== undefined ? { signal } : {}),
            })
        : direction === 'pull'
          ? await this.apiPull(binding, signal)
          : await apiSnapshotPush(binding, this.api, { ...(await this.sessionFor('api')), origin: this.config.baseUrl }, {
              ...(signal !== undefined ? { signal } : {}),
            })
      await markSynced(mirrorPath).catch(() => undefined)
      return result
    } finally {
      this.syncInFlight.delete(mirrorPath)
    }
  }

  /** One-way snapshot pull through the API transport (free-account fallback). */
  private async apiPull(binding: OverleafBinding, signal?: AbortSignal): Promise<OverleafSyncResult> {
    const zip = await this.api.downloadZip(binding.projectId, await this.sessionFor('api'))
    const message = await apiSnapshotPull(binding, zip, await this.sessionFor('api'), signal)
    return {
      direction: 'pull',
      projectId: binding.projectId,
      mirrorPath: binding.mirrorPath,
      transport: 'api',
      message,
    }
  }

  /**
   * Live remote position of one mirror. Git mirrors fetch and count; API
   * mirrors (no git remote) degrade to local-only facts with
   * `remoteAvailable: false` so the tab can explain why.
   */
  async remoteStatus(mirrorPath: string, signal?: AbortSignal): Promise<OverleafRemoteStatus> {
    const binding = await readBinding(mirrorPath)
    if (binding === undefined) throw new Error('overleaf: directory is not bound; bind a project first')
    const kind = await this.syncTransport(binding, 'pull').catch(() => 'api' as OverleafTransportKind)
    const statusOutput = await runGit(['status', '--porcelain'], mirrorPath, {}, signal)
    const dirtyLines = statusOutput.split('\n').filter(line => line.trim() !== '')
    const localCommitTime = await runGit(['log', '-1', '--format=%cI', 'HEAD'], mirrorPath, {}, signal)
      .then(out => out.trim(), () => undefined)
    const lastSync = await loadRegistry().then(registry => registry.lastSync[mirrorPath])
    if (kind !== 'git') {
      return {
        projectId: binding.projectId,
        mirrorPath,
        transport: 'api',
        branch: '',
        ahead: 0,
        behind: 0,
        diverged: false,
        dirty: dirtyLines.length > 0,
        dirtyCount: dirtyLines.length,
        ...(localCommitTime !== undefined && localCommitTime !== '' ? { localCommitTime } : {}),
        ...(lastSync !== undefined ? { lastSyncTime: lastSync } : {}),
        remoteAvailable: false,
      }
    }
    const status = await this.git.readStatus(binding, await this.sessionFor('git'), signal)
    return {
      projectId: binding.projectId,
      mirrorPath,
      transport: 'git',
      branch: status.branch,
      ahead: status.ahead,
      behind: status.behind,
      diverged: status.diverged,
      dirty: status.dirty,
      dirtyCount: status.dirtyCount,
      ...(status.remoteCommitTime !== undefined ? { remoteCommitTime: status.remoteCommitTime } : {}),
      ...(status.localCommitTime !== undefined ? { localCommitTime: status.localCommitTime } : {}),
      ...(lastSync !== undefined ? { lastSyncTime: lastSync } : {}),
      remoteAvailable: true,
    }
  }

  /** Compile one mirror locally with latexmk. */
  async compile(mirrorPath: string, signal?: AbortSignal): Promise<OverleafCompileResult> {
    const binding = await readBinding(mirrorPath)
    if (binding === undefined) throw new Error('overleaf: directory is not bound; bind a project first')
    return await compileMirror(mirrorPath, signal !== undefined ? { signal } : {})
  }

  /**
   * Upgrade a snapshot-only mirror to two-way git sync without touching its
   * files: attach the Overleaf git remote, splice the local snapshot content
   * on top of the remote history via a soft reset + commit, and flip the
   * binding's transport. The user still chooses when to push.
   */
  async upgradeToGit(mirrorPath: string, signal?: AbortSignal): Promise<OverleafBinding & { branch: string; message: string }> {
    const binding = await readBinding(mirrorPath)
    if (binding === undefined) throw new Error('overleaf: directory is not bound; bind a project first')
    if (binding.transport === 'git') throw new Error('overleaf: 该镜像已经是 Git 双向同步模式')
    const token = await this.ctx.credentials.describe(OVERLEAF_GIT_TOKEN)
    if (!token.configured) {
      throw new Error('overleaf: 切换 Git 双向同步需要先在「设置 → 连接 Overleaf」中配置 Git 令牌（Overleaf 付费功能）')
    }
    const session = await this.sessionFor('git')
    const remoteUrl = this.git.remote(binding.projectId)
    const hasRemote = await this.git.hasRemote(mirrorPath, session, signal)
    await runGit(
      hasRemote ? ['remote', 'set-url', 'origin', remoteUrl] : ['remote', 'add', 'origin', remoteUrl],
      mirrorPath,
      session,
      signal,
    )
    // Commit pending edits so the soft reset below cannot lose them.
    await commitAll(mirrorPath, `同步本地修改 (${new Date().toISOString()})`, session, signal)
    await runGit(['fetch', 'origin', '--prune'], mirrorPath, session, signal)
    // Resolve the remote's default branch: prefer origin/HEAD, then the first
    // real branch. Bare `origin` (a HEAD symref entry) and `origin/HEAD`
    // itself must never be treated as a branch — resetting onto them mangles
    // the index (observed: the remote's files got deleted on upgrade).
    const headRef = await runGit(
      ['rev-parse', '--abbrev-ref', 'origin/HEAD'],
      mirrorPath,
      session,
      signal,
    ).then(out => out.trim(), () => '')
    let branch = headRef.startsWith('origin/') ? headRef.slice('origin/'.length) : ''
    if (branch === '') {
      branch = (await runGit(
        ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'],
        mirrorPath,
        session,
        signal,
      ))
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('origin/') && !line.endsWith('/HEAD'))[0]
        ?.slice('origin/'.length) ?? ''
    }
    if (branch === undefined) {
      throw new Error('overleaf: 远端没有任何分支；确认该项目在 Overleaf 上仍可见后重试')
    }
    // Splice: move HEAD onto the remote history, keep the working tree, then
    // commit the snapshot content as one local commit on top of it. A remote
    // newer than the snapshot would be overwritten by that commit, so refuse
    // and let the user pull a fresh snapshot first.
    const remoteTime = Number.parseInt(
      await runGit(['log', '-1', '--format=%ct', `origin/${branch}`], mirrorPath, session, signal),
      10,
    )
    const snapshotTime = Number.parseInt(
      await runGit(['log', '-1', '--format=%ct', 'HEAD'], mirrorPath, session, signal),
      10,
    )
    if (Number.isFinite(remoteTime) && Number.isFinite(snapshotTime) && remoteTime > snapshotTime) {
      throw new Error('overleaf: 远端比本地快照新，请先「拉取更新」同步到最新快照，再切换 Git 双向同步（否则会覆盖 Overleaf 上的新修改）')
    }
    await runGit(['reset', '--soft', `origin/${branch}`], mirrorPath, session, signal)
    await commitAll(mirrorPath, '从网页快照迁移到 Git 双向同步', session, signal)
    const upgraded: OverleafBinding & { branch: string; message: string } = {
      ...binding,
      transport: 'git',
      branch,
      message: `已切换为 Git 双向同步（分支 ${branch}）；本地内容尚未推送，确认无误后点「推送修改」发布`,
    }
    await writeBinding({ projectId: binding.projectId, projectName: binding.projectName, mirrorPath, transport: 'git' })
    await upsertRegistryBinding({
      projectId: binding.projectId,
      projectName: binding.projectName,
      mirrorPath,
    }).catch(() => undefined)
    return upgraded
  }

  /** Current auto-sync policy. */
  async getAutoSync(): Promise<OverleafAutoSyncPolicy> {
    return (await loadRegistry()).policy
  }

  /** Persist a new auto-sync policy and reschedule the background puller. */
  async setAutoSync(policy: OverleafAutoSyncPolicy): Promise<OverleafAutoSyncPolicy> {
    await savePolicy(policy)
    await this.rescheduleAutoSync()
    return policy
  }

  /** Restart the background scheduler from the persisted policy. */
  private async rescheduleAutoSync(): Promise<void> {
    if (this.autoSyncTimer !== undefined) clearTimeout(this.autoSyncTimer)
    const policy = await this.getAutoSync()
    const intervalMs = AUTO_PULL_INTERVAL_MS[policy.autoPullInterval] ?? 0
    if (intervalMs <= 0) return
    this.autoSyncTimer = setTimeout(() => {
      void this.runAutoSyncCycle().finally(() => { void this.rescheduleAutoSync() })
    }, intervalMs)
  }

  /**
   * One background pass: pull every registered mirror that still carries a
   * binding file, optionally pushing afterwards. Dirty mirrors are pulled
   * only when auto-commit is on (otherwise they are skipped — pushing the
   * user's half-written work silently would be worse than waiting).
   */
  private async runAutoSyncCycle(): Promise<void> {
    const registry = await loadRegistry()
    const policy = registry.policy
    for (const entry of registry.bindings) {
      if (this.syncInFlight.has(entry.mirrorPath)) continue
      const binding = await readBinding(entry.mirrorPath).catch(() => undefined)
      if (binding === undefined) continue
      if (this.syncInFlight.has(entry.mirrorPath)) continue
      this.syncInFlight.add(entry.mirrorPath)
      try {
        const kind = await this.syncTransport(binding, 'pull').catch(() => undefined)
        if (kind === undefined) continue
        if (kind === 'git') {
          const session = await this.sessionFor('git')
          await this.git.smartPull(binding, session, { autoCommit: policy.autoCommitLocal })
          if (policy.autoPush) {
            await this.git.smartPush(binding, session, { autoCommit: policy.autoCommitLocal })
          }
        } else {
          await this.apiPull(binding)
        }
        await markSynced(entry.mirrorPath).catch(() => undefined)
      } catch (error) {
        // Background sync never throws into the host; the tab surfaces the
        // state on its next check.
        console.warn(`[dsh-better-overleaf] auto-sync skipped ${entry.projectName}:`, error instanceof Error ? error.message : error)
      } finally {
        this.syncInFlight.delete(entry.mirrorPath)
      }
    }
  }
}

export default OverleafService
