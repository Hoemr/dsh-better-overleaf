/**
 * Host-service assembly tests: mount OverleafService on a real Cordis context
 * with mock webServer/credentials providers, then drive the registered route
 * handlers directly through the wire contract (envelope, loopback guard,
 * credential storage, binding listing).
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OverleafService } from '../src/service.ts'
import type { Config } from '../src/service.ts'

type RouteHandler = (req: unknown, res: unknown) => Promise<void>

class MockWebServer extends Service {
  readonly routes = new Map<string, RouteHandler>()
  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }
  register(entry: { kind: string; path: string; handler: RouteHandler }): void {
    this.routes.set(entry.path, entry.handler)
  }
}

class MockCredentials extends Service {
  readonly store = new Map<string, string>()
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }
  async describe(ref: string): Promise<{ configured: boolean }> {
    return { configured: this.store.has(String(ref)) }
  }
  async resolve(ref: string): Promise<{ value: string } | undefined> {
    const value = this.store.get(String(ref))
    return value === undefined ? undefined : { value }
  }
  async set(ref: string, value: string): Promise<void> {
    this.store.set(String(ref), value)
  }
}

interface FakeResponse {
  headersSent: boolean
  statusCode: number
  headers: Record<string, unknown>
  body: string
  writeHead(status: number, headers: Record<string, unknown>): void
  end(payload: string): void
  destroy(): void
}

function fakeRequest(payload: unknown, remoteAddress = '127.0.0.1'): unknown {
  const data = Buffer.from(JSON.stringify(payload))
  return {
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      yield data
    },
  }
}

function fakeResponse(): FakeResponse {
  const response = {
    headersSent: false,
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: '',
    writeHead(status: number, headers: Record<string, unknown>): void {
      response.statusCode = status
      response.headers = headers
      response.headersSent = true
    },
    end(payload: string): void {
      response.body += payload
    },
    destroy(): void {},
  }
  return response
}

async function call(routes: Map<string, RouteHandler>, path: string, payload: unknown, remoteAddress?: string): Promise<{ status: number; envelope: Record<string, unknown> }> {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`route ${path} not registered`)
  const res = fakeResponse()
  await handler(remoteAddress === undefined ? fakeRequest(payload) : fakeRequest(payload, remoteAddress), res)
  return { status: res.statusCode, envelope: JSON.parse(res.body) as Record<string, unknown> }
}

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-overleaf-svc-'))
  tempDirs.push(dir)
  return dir
}

let ctx: Context

beforeEach(() => {
  ctx = new Context()
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }).catch(() => undefined)))
})

describe('OverleafService mounting', () => {
  it('registers every /overleaf route on the web server', async () => {
    await ctx.plugin(MockWebServer)
    await ctx.plugin(MockCredentials)
    await ctx.plugin(OverleafService, {} as Config)
    const routes = ctx.webServer.routes as Map<string, RouteHandler>
    expect([...routes.keys()].sort()).toEqual([
      '/overleaf/bind',
      '/overleaf/bindings',
      '/overleaf/cookie',
      '/overleaf/git-token',
      '/overleaf/login',
      '/overleaf/projects',
      '/overleaf/status',
      '/overleaf/sync',
      '/overleaf/unbind',
    ])
  })

  it('serves account status with the shared ok envelope', async () => {
    await ctx.plugin(MockWebServer)
    await ctx.plugin(MockCredentials)
    await ctx.plugin(OverleafService, {} as Config)
    const routes = ctx.webServer.routes as Map<string, RouteHandler>
    const { status, envelope } = await call(routes, '/overleaf/status', {})
    expect(status).toBe(200)
    expect(envelope).toEqual({
      ok: true,
      value: { loggedIn: false, gitConfigured: false, transport: 'auto' },
    })
  })

  it('lists workspace bindings through the status route', async () => {
    await ctx.plugin(MockWebServer)
    await ctx.plugin(MockCredentials)
    await ctx.plugin(OverleafService, {} as Config)
    const routes = ctx.webServer.routes as Map<string, RouteHandler>
    const workspacePath = await makeTempDir()
    const { envelope } = await call(routes, '/overleaf/status', { workspacePath })
    expect(envelope.ok).toBe(true)
    expect((envelope.value as { bindings: unknown[] }).bindings).toEqual([])
  })

  it('rejects non-loopback callers before reading the payload', async () => {
    await ctx.plugin(MockWebServer)
    await ctx.plugin(MockCredentials)
    await ctx.plugin(OverleafService, {} as Config)
    const routes = ctx.webServer.routes as Map<string, RouteHandler>
    const { status, envelope } = await call(routes, '/overleaf/status', {}, '203.0.113.7')
    expect(status).toBe(403)
    expect(envelope).toMatchObject({ ok: false, error: { code: 'overleaf-loopback-only' } })
  })

  it('stores the git token through the credentials service', async () => {
    await ctx.plugin(MockWebServer)
    await ctx.plugin(MockCredentials)
    await ctx.plugin(OverleafService, {} as Config)
    const routes = ctx.webServer.routes as Map<string, RouteHandler>
    const credentials = ctx.credentials as MockCredentials
    const saved = await call(routes, '/overleaf/git-token', { token: ' bridge-secret ' })
    expect(saved.envelope.ok).toBe(true)
    expect(credentials.store.get('OVERLEAF_GIT_TOKEN')).toBe('bridge-secret')
    const { envelope } = await call(routes, '/overleaf/status', {})
    expect((envelope.value as { gitConfigured: boolean }).gitConfigured).toBe(true)
  })

  it('reports errors through the shared error envelope', async () => {
    await ctx.plugin(MockWebServer)
    await ctx.plugin(MockCredentials)
    await ctx.plugin(OverleafService, {} as Config)
    const routes = ctx.webServer.routes as Map<string, RouteHandler>
    const { envelope } = await call(routes, '/overleaf/bindings', { workspacePath: 'relative/path' })
    expect(envelope.ok).toBe(false)
    expect((envelope.error as { message: string }).message).toContain('absolute workspacePath')
  })

  it('unbind is an idempotent no-op for an absent mirror', async () => {
    await ctx.plugin(MockWebServer)
    await ctx.plugin(MockCredentials)
    await ctx.plugin(OverleafService, {} as Config)
    const routes = ctx.webServer.routes as Map<string, RouteHandler>
    const mirrorPath = await makeTempDir()
    const { envelope } = await call(routes, '/overleaf/unbind', { mirrorPath })
    expect(envelope).toEqual({ ok: true, value: false })
  })

  it('saveCookie stores only cookies Overleaf accepts as a session', async () => {
    await ctx.plugin(MockWebServer)
    await ctx.plugin(MockCredentials)
    await ctx.plugin(OverleafService, {} as Config)
    const routes = ctx.webServer.routes as Map<string, RouteHandler>
    const credentials = ctx.credentials as MockCredentials

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    try {
      const rejected = await call(routes, '/overleaf/cookie', { cookie: 'GCLB=crumb' })
      expect(rejected.envelope.ok).toBe(false)
      expect((rejected.envelope.error as { message: string }).message).toContain('overleaf_session2')
      expect(credentials.store.has('OVERLEAF_COOKIE')).toBe(false)

      vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>dashboard</html>', { status: 200 })))
      const accepted = await call(routes, '/overleaf/cookie', { cookie: ' overleaf_session2=real ' })
      expect(accepted.envelope.ok).toBe(true)
      expect(credentials.store.get('OVERLEAF_COOKIE')).toBe('overleaf_session2=real')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('bind via the API seed path (mock Overleaf, real zip + git)', () => {
  it('creates the mirror, extracts the snapshot, and commits it', { timeout: 60_000 }, async () => {
    if (process.platform !== 'win32') return // fixture zip is built with Compress-Archive
    const projectId = 'abc123def456abc123def456'
    const workspacePath = await makeTempDir()

    // Build the snapshot zip the mocked download endpoint will serve.
    const staging = await makeTempDir('dsh-overleaf-bind-stage-')
    await writeFile(join(staging, 'main.tex'), '\\documentclass{article}\n')
    await mkdir(join(staging, 'figures'))
    await writeFile(join(staging, 'figures', 'fig.png'), 'png-bytes')
    const zipPath = join(staging, '..', 'bind-fixture.zip')
    const compress = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zipPath}' -Force`,
    ], { windowsHide: true })
    if (compress.status !== 0) throw new Error(`Compress-Archive failed: ${compress.stderr}`)
    const zip = await readFile(zipPath)

    const fetchMock = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === 'string' ? url : url instanceof Request ? url.url : url.href
      if (href.endsWith('/api/project')) {
        return new Response(JSON.stringify([{ id: projectId, name: 'My Paper' }]), { status: 200 })
      }
      if (href.endsWith(`/project/${projectId}/download/zip`)) {
        return new Response(new Uint8Array(zip), { status: 200 })
      }
      return new Response('unexpected', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      await ctx.plugin(MockWebServer)
      await ctx.plugin(MockCredentials)
      await ctx.plugin(OverleafService, {} as Config)
      ;(ctx.credentials as MockCredentials).store.set('OVERLEAF_COOKIE', 'session=1')
      const routes = ctx.webServer.routes as Map<string, RouteHandler>

      const saved = await call(routes, '/overleaf/bind', {
        workspacePath,
        projectId,
        transport: 'api',
      })
      expect(saved.envelope.ok).toBe(true)
      const binding = saved.envelope.value as { mirrorPath: string; projectName: string; transport: string }
      expect(binding.projectName).toBe('My Paper')
      expect(binding.mirrorPath).toBe(join(workspacePath, 'overleaf', 'My Paper'))

      // Snapshot content landed and was committed into a clean git repo.
      await expect(readFile(join(binding.mirrorPath, 'main.tex'), 'utf8')).resolves.toContain('documentclass')
      await expect(readFile(join(binding.mirrorPath, 'figures', 'fig.png'), 'utf8')).resolves.toBe('png-bytes')
      const status = spawnSync('git', ['status', '--porcelain'], { cwd: binding.mirrorPath, encoding: 'utf8' })
      expect(status.stdout.trim()).toBe('')
      const log = spawnSync('git', ['log', '--oneline'], { cwd: binding.mirrorPath, encoding: 'utf8' })
      expect(log.stdout.trim()).not.toBe('')

      // The workspace bindings route now reports the fresh mirror.
      const listed = await call(routes, '/overleaf/bindings', { workspacePath })
      const bindings = (listed.envelope.value as { bindings: Array<{ mirrorPath: string }> }).bindings
      expect(bindings.map(entry => entry.mirrorPath)).toContain(binding.mirrorPath)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('refuses to bind a project the account cannot see', async () => {
    const projectId = 'invisible00000000000000'
    const workspacePath = await makeTempDir()
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> =>
      new Response(JSON.stringify([{ id: 'other000000000000000000', name: 'Other' }]), { status: 200 })))
    try {
      await ctx.plugin(MockWebServer)
      await ctx.plugin(MockCredentials)
      await ctx.plugin(OverleafService, {} as Config)
      ;(ctx.credentials as MockCredentials).store.set('OVERLEAF_COOKIE', 'session=1')
      const routes = ctx.webServer.routes as Map<string, RouteHandler>
      const { envelope } = await call(routes, '/overleaf/bind', { workspacePath, projectId })
      expect(envelope.ok).toBe(false)
      expect((envelope.error as { message: string }).message).toContain('not visible')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
