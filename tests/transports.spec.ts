import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  allocateMirrorDir, listWorkspaceBindings, readBinding, removeBinding, safeMirrorName, writeBinding,
} from '../src/paths.ts'
import { OverleafApiTransport } from '../src/transports.ts'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-better-overleaf-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('mirror binding files', () => {
  it('round-trips one binding through .overleaf.json and removes it', async () => {
    const workspacePath = await makeTempDir()
    const mirrorPath = join(workspacePath, 'overleaf', 'demo')
    await mkdir(mirrorPath, { recursive: true })
    await expect(readBinding(mirrorPath)).resolves.toBeUndefined()
    await writeBinding({ projectId: 'abc123', projectName: 'Demo', mirrorPath, transport: 'auto' })
    await expect(readBinding(mirrorPath)).resolves.toEqual({
      projectId: 'abc123',
      projectName: 'Demo',
      mirrorPath,
      transport: 'auto',
    })
    await expect(removeBinding(mirrorPath)).resolves.toBe(true)
    await expect(readBinding(mirrorPath)).resolves.toBeUndefined()
    await expect(removeBinding(mirrorPath)).resolves.toBe(false)
  })

  it('lists every bound mirror under <workspace>/overleaf and skips foreign folders', async () => {
    const workspacePath = await makeTempDir()
    const bound = join(workspacePath, 'overleaf', 'paper')
    const foreign = join(workspacePath, 'overleaf', 'not-a-mirror')
    await mkdir(bound, { recursive: true })
    await mkdir(foreign, { recursive: true })
    await writeBinding({ projectId: 'p1', projectName: 'Paper', mirrorPath: bound, transport: 'git' })
    await expect(listWorkspaceBindings(workspacePath)).resolves.toEqual([
      { projectId: 'p1', projectName: 'Paper', mirrorPath: bound, transport: 'git' },
    ])
    await expect(listWorkspaceBindings(join(workspacePath, 'missing'))).resolves.toEqual([])
  })

  it('allocates deduplicated mirror directories', async () => {
    const workspacePath = await makeTempDir()
    const first = await allocateMirrorDir(workspacePath, 'demo')
    const second = await allocateMirrorDir(workspacePath, 'demo')
    expect(first).toBe(join(workspacePath, 'overleaf', 'demo'))
    expect(second).toBe(join(workspacePath, 'overleaf', 'demo (2)'))
  })
})

describe('safeMirrorName', () => {
  it('strips filesystem-hostile characters and length', () => {
    expect(safeMirrorName('My Paper: Final?', 'abcdef123456')).toBe('My Paper Final')
    expect(safeMirrorName('   ', 'abcdef123456')).toBe('project-abcdef12')
    expect(safeMirrorName('x'.repeat(100), 'abcdef123456')).toHaveLength(64)
  })
})

describe('Overleaf API transport', () => {
  it('parses the common project-list payloads', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta', updatedAt: '2026-08-16T00:00:00Z' },
    ]), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const transport = new OverleafApiTransport('https://www.overleaf.com')
    await expect(transport.listProjects({ cookie: 'session=1' })).resolves.toEqual([
      { id: 'a', name: 'Alpha' },
      { id: 'b', name: 'Beta', updatedAt: '2026-08-16T00:00:00Z' },
    ])
  })

  it('rejects zip downloads without a cookie', async () => {
    const transport = new OverleafApiTransport('https://www.overleaf.com')
    await expect(transport.downloadZip('abc', {})).rejects.toThrow('OVERLEAF_COOKIE is not configured')
  })

  it('parses the ol-prefetchedProjectsBlob meta when the JSON endpoints are gone', async () => {
    const dashboard = '<html><head>'
      + '<meta name="ol-csrfToken" content="csrf" />'
      + '<meta data-attr="first" name="ol-prefetchedProjectsBlob" content="{&quot;totalSize&quot;:3,&quot;projects&quot;:[{&quot;id&quot;:&quot;abc123def456&quot;,&quot;name&quot;:&quot;Meta Paper&quot;,&quot;lastUpdated&quot;:&quot;2026-01-01T00:00:00Z&quot;,&quot;archived&quot;:false,&quot;trashed&quot;:false},{&quot;id&quot;:&quot;fff000fff000&quot;,&quot;name&quot;:&quot;Plain &amp; Simple&quot;,&quot;archived&quot;:true},{&quot;id&quot;:&quot;eee111eee111&quot;,&quot;name&quot;:&quot;Trashed Doc&quot;,&quot;trashed&quot;:true}]}" />'
      + '</head><body></body></html>'
    const fetchMock = vi.fn(async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === 'string' ? url : url instanceof Request ? url.url : url.href
      if (href.endsWith('/project')) return new Response(dashboard, { status: 200 })
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const transport = new OverleafApiTransport('https://www.overleaf.com')
    await expect(transport.listProjects({ cookie: 'overleaf_session2=real' })).resolves.toEqual([
      { id: 'abc123def456', name: 'Meta Paper', updatedAt: '2026-01-01T00:00:00Z' },
    ])
  })

  it('validateCookie accepts an authenticated dashboard response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>dashboard</html>', { status: 200 })))
    const transport = new OverleafApiTransport('https://www.overleaf.com')
    await expect(transport.validateCookie('overleaf_session2=real')).resolves.toBeUndefined()
  })

  it('validateCookie rejects anonymous crumbs with the httpOnly hint', async () => {
    for (const status of [401, 302]) {
      const headers = status === 302 ? { location: '/login' } : {}
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status, headers })))
      const transport = new OverleafApiTransport('https://www.overleaf.com')
      await expect(transport.validateCookie('GCLB=anonymous-crumb')).rejects.toThrow(/overleaf_session2/)
    }
  })
})
