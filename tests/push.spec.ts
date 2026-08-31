/**
 * Snapshot-push integration tests: the website-endpoint push against a local
 * fixture standing in for overleaf.com. `fetch` is stubbed to serve the
 * project page (CSRF), the folder/upload/delete routes, and the zip snapshots;
 * the socket.io 0.9 `joinProject` handshake is answered by a local WebSocket
 * server implementing the minimal 0.9 frames.
 */
import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { OverleafApiTransport, apiSnapshotPush } from '../src/transports.ts'
import type { OverleafBinding } from '../src/types.ts'

const tempDirs: string[] = []
const LOCAL_TOKEN = { gitToken: 'local-test-token' }
const COOKIE = 'overleaf_session2=test-session'
const PROJECT_ID = 'pushproj0000000000000'

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

/** Build a zip of one directory with PowerShell (mirror of the pull tests). */
async function zipDir(dir: string): Promise<Buffer> {
  const zipPath = `${dir}.zip`
  const compress = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zipPath}' -Force`,
  ], { windowsHide: true })
  if (compress.status !== 0) throw new Error(`Compress-Archive failed: ${compress.stderr}`)
  return await readFile(zipPath)
}

interface Fixture {
  /** Latest remote tree: relative posix path → content. */
  remote: Map<string, string>
  /** Requests the client made, for assertions. */
  requests: Array<{ method: string; path: string }>
  server: Server
  wss: Server
  port: number
  close: () => void
}

/**
 * Stand-in for overleaf.com: serves the editor page (CSRF), folder create,
 * upload, delete, and the zip download; answers joinProject over a real
 * socket.io-0.9-shaped WebSocket. Remote mutations go through the same routes
 * the plugin calls, so the fixture tree only changes via its own endpoints.
 */
async function startFixture(initial: Record<string, string>): Promise<Fixture> {
  const remote = new Map(Object.entries(initial))
  /** Entity id → tree path, so DELETE routes can locate entries. */
  const idToPath = new Map<string, string>()
  const requests: Array<{ method: string; path: string }> = []
  const csrfToken = 'fixture-csrf-token'
  let uploadCounter = 0

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture')
    requests.push({ method: req.method ?? '', path: url.pathname })
    console.log('[fixture http]', req.method, url.pathname)
    if (req.method === 'GET' && url.pathname.startsWith('/socket.io/1/')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`sid-${String(Date.now())}:15000:10000:websocket`)
      return
    }
    if (req.method === 'GET' && url.pathname === '/project') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><script>window.csrfToken = "${csrfToken}";</script></html>`)
      return
    }
    if (req.method === 'GET' && url.pathname === `/project/${PROJECT_ID}/download/zip`) {
      // Serve the current remote tree as a zip: write it to a scratch dir and
      // compress with the same platform tooling the pull path uses.
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
      const fs = require('node:fs') as typeof import('node:fs')
      const os = require('node:os') as typeof import('node:os')
      const path = require('node:path') as typeof import('node:path')
      const scratch = fs.mkdtempSync(join(os.tmpdir(), 'fixture-zip-'))
      for (const [rel, content] of remote) {
        const target = join(scratch, rel)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content)
      }
      const zipPath = join(scratch, 'out.zip')
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Compress-Archive -Path '${scratch}\\*' -DestinationPath '${zipPath}' -Force`], { windowsHide: true })
      res.writeHead(200, { 'content-type': 'application/zip' })
      res.end(fs.readFileSync(zipPath))
      fs.rmSync(scratch, { recursive: true, force: true })
      return
    }
    if (req.method === 'POST' && url.pathname === `/project/${PROJECT_ID}/upload`) {
      void (async (): Promise<void> => {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const body = Buffer.concat(chunks).toString('binary')
        if (req.headers['x-csrf-token'] !== csrfToken) {
          res.writeHead(403); res.end('{"success":false}'); return
        }
        // Split multipart by the real boundary and pull the qqfilename field
        // plus the qqfile payload out of their parts (text fixtures only).
        const boundary = (req.headers['content-type'] ?? '').match(/boundary=([^;]+)/)?.[1]
        const name = url.searchParams.get('qqfilename') ?? `uploaded-${String(uploadCounter++)}.tex`
        let content = ''
        if (boundary !== undefined) {
          for (const part of body.split(`--${boundary}`)) {
            const nameMatch = part.match(/name="qqfilename"\r\n\r\n([^\r\n]+)/)
            if (nameMatch !== null) name = nameMatch[1]
            if (part.includes('name="qqfile"')) {
              const payload = part.match(/\r\n\r\n([\s\S]*?)(?:\r\n--|$)/)
              if (payload !== null) content = payload[1].replace(/\r\n$/, '')
            }
          }
        }
        remote.set(name, content)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
      })()
      return
    }
    const deleteMatch = req.method === 'DELETE'
      ? url.pathname.match(/^\/project\/[^/]+\/(doc|file)\/(.+)$/)
      : null
    if (deleteMatch !== null) {
      const target = idToPath.get(deleteMatch[2] ?? '')
      if (target !== undefined) remote.delete(target)
      res.writeHead(204); res.end(); return
    }
    res.writeHead(404); res.end('fixture: unexpected route')
  })

  // socket.io 0.9: HTTP handshake for the sid, then a WebSocket that answers
  // the single joinProject emit with the current tree.
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const match = (req.url ?? '').match(/^\/socket\.io\/1\/websocket\/([^?]+)/)
    if (match === null) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (client: WebSocket) => {
      client.send('1::') // connect frame
      client.on('message', (raw: unknown) => {
        const frame = String(raw)
        const emit = frame.match(/^5:(\d+):(.*)$/)
        if (emit === null) return
        void (async (): Promise<void> => {
          const [event, payload] = JSON.parse(emit[2] ?? '[]') as [string, { project_id?: string }]
          if (event === 'joinProject') {
            // Shape mirrors the editor's joinProject payload: rootFolder[0]
            // with docs/files/folders; flat names suffice for the fixture.
            const docs = [...remote.keys()].map((rel, index) => {
              const id = `doc${String(index)}`
              idToPath.set(id, rel)
              return { _id: id, name: rel }
            })
            client.send(`6:${String(emit[1])}:[null,${JSON.stringify({
              name: 'fixture', _id: payload?.project_id ?? PROJECT_ID,
              rootFolder: [{ _id: 'root-folder', name: 'root', docs, files: [], folders: [] }],
            })}]`)
          }
        })().catch(() => { client.close() })
      })
    })
  })

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    wss.close()
    server.close()
  }
  return { remote, requests, server, wss, port, close }
}

const createdServers: Fixture[] = []

afterAll(() => {
  for (const fixture of createdServers) fixture.close()
})

describe('apiSnapshotPush (website endpoints)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pushes local additions, updates, and deletions to the remote', { timeout: 120_000 }, async () => {
    if (process.platform !== 'win32') return // zip fixtures are built with Compress-Archive
    const workspace = await makeTempDir('dsh-better-overleaf-push-')
    const mirrorPath = join(workspace, 'overleaf', 'paper')
    const fixture = await startFixture({ 'main.tex': 'remote version\n', 'notes/old.tex': 'remote notes\n' })
    createdServers.push(fixture)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(mirrorPath, { recursive: true })
    await writeFile(join(mirrorPath, 'main.tex'), 'remote version\n')
    await mkdir(join(mirrorPath, 'notes'), { recursive: true })
    await writeFile(join(mirrorPath, 'notes', 'old.tex'), 'remote notes\n')
    git(mirrorPath, ['init', '-b', 'main'])
    git(mirrorPath, ['config', 'user.name', 'test'])
    git(mirrorPath, ['config', 'user.email', 'test@local'])
    git(mirrorPath, ['add', '.'])
    git(mirrorPath, ['commit', '-m', 'snapshot'])
    await writeFile(join(mirrorPath, 'local.tex'), 'brand new\n')
    await writeFile(join(mirrorPath, 'main.tex'), 'local update\n')
    await rm(join(mirrorPath, 'notes', 'old.tex'))
    git(mirrorPath, ['add', '-A'])
    git(mirrorPath, ['commit', '-m', 'local work'])
    git(mirrorPath, ['remote', 'add', 'origin', `file:///${workspace.replaceAll('\\', '/')}/unused.git`])

    // Point the transport at the fixture and stub fetch: /project (CSRF) and
    // the zip download go to the fixture HTTP server; upload/delete URLs only
    // need to be recognizable, since the fixture serves every POST/DELETE.
    const transport = new OverleafApiTransport(`http://127.0.0.1:${String(fixture.port)}`)
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: unknown) => {
      const url = typeof input === 'string' ? input : String((input as URL).toString())
      if (url.includes('/socket.io/1/') || url.includes('/download/zip')) {
        return await realFetch(input as never, init as never)
      }
      // Website mutations (folder/upload/delete) hit the fixture's HTTP server.
      const rewritten = url.replace('https://www.overleaf.com', `http://127.0.0.1:${String(fixture.port)}`)
      return await realFetch(rewritten as never, init as never)
    }))

    const binding: OverleafBinding = { projectId: PROJECT_ID, projectName: 'paper', mirrorPath, transport: 'api' }
    const result = await apiSnapshotPush(binding, transport, { cookie: COOKIE, origin: `http://127.0.0.1:${String(fixture.port)}` })

    expect(result.transport).toBe('api')
    expect(result.message).toContain('已推送')
    // Remote tree reflects the local work: addition, update, and deletion.
    expect(fixture.remote.get('local.tex')).toBe('brand new\n')
    expect(fixture.remote.get('main.tex')).toBe('local update\n')
    expect(fixture.remote.has('notes/old.tex')).toBe(false)
    // Confirming pull landed the merged state locally.
    await expect(readFile(join(mirrorPath, 'local.tex'), 'utf8')).resolves.toBe('brand new\n')
    // CSRF was picked up from the project page before mutations.
    expect(fixture.requests.some(request => request.path === '/project')).toBe(true)
  })
})
