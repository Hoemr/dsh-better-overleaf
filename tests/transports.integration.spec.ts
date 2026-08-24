/**
 * Integration tests for the two sync legs, run against local fixtures instead
 * of Overleaf: the git transport against a local bare remote standing in for
 * `git.overleaf.com/<id>`, and the API snapshot pull against a real zip built
 * with platform tooling. Requires the `git` binary on PATH.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OverleafBinding } from '../src/types.ts'
import { OverleafGitTransport, apiSnapshotPull } from '../src/transports.ts'

const tempDirs: string[] = []
/** Local file:// remotes ignore http auth; the token only satisfies the guard. */
const LOCAL_TOKEN = { gitToken: 'local-test-token' }

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

/** Read a text file with CRLF normalized away (Windows autocrlf checkouts). */
async function readText(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).replaceAll('\r\n', '\n')
}

afterEach(async () => {
  // Best-effort: git child processes may hold locks briefly on Windows.
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }).catch(() => undefined)))
})

describe('OverleafGitTransport against a local bridge stand-in', () => {
  it('clones, pulls upstream commits, and pushes local commits', { timeout: 120_000 }, async () => {
    const bridgeRoot = await makeTempDir('dsh-overleaf-bridge-')
    const bare = join(bridgeRoot, 'proj1.git')
    const seed = join(bridgeRoot, 'seed')
    const transport = new OverleafGitTransport(`file:///${bridgeRoot.replaceAll('\\', '/')}`)

    // Seed the fake bridge through a normal working repo pushed to the bare remote.
    git(bridgeRoot, ['init', '--bare', '-b', 'main', 'proj1.git'])
    git(bridgeRoot, ['clone', 'proj1.git', 'seed'])
    await writeFile(join(seed, 'main.tex'), 'Hello Overleaf\n')
    git(seed, ['add', '.'])
    git(seed, ['commit', '-m', 'seed'])
    git(seed, ['push', 'origin', 'HEAD:main'])

    // Clone through the transport exactly like bind() does.
    const mirrorPath = await makeTempDir('dsh-overleaf-mirror-')
    await rm(mirrorPath, { recursive: true })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(mirrorPath, { recursive: true })
    await expect(transport.clone('proj1', mirrorPath, LOCAL_TOKEN)).resolves.toBeDefined()
    await expect(readText(join(mirrorPath, 'main.tex'))).resolves.toBe('Hello Overleaf\n')

    const binding: OverleafBinding = { projectId: 'proj1', projectName: 'proj1', mirrorPath, transport: 'git' }

    // Upstream moves; pull brings the change in.
    await writeFile(join(seed, 'bib.bib'), '@article{a, title={A}}\n')
    git(seed, ['add', '.'])
    git(seed, ['commit', '-m', 'add bib'])
    git(seed, ['push', 'origin', 'HEAD:main'])
    const pull = await transport.sync(binding, 'pull', LOCAL_TOKEN)
    expect(pull.transport).toBe('git')
    await expect(readText(join(mirrorPath, 'bib.bib'))).resolves.toBe('@article{a, title={A}}\n')

    // Local edit; push publishes it back to the bridge.
    await writeFile(join(mirrorPath, 'main.tex'), 'Hello edited\n')
    git(mirrorPath, ['add', '.'])
    git(mirrorPath, ['commit', '-m', 'local edit'])
    const push = await transport.sync(binding, 'push', LOCAL_TOKEN)
    expect(push.direction).toBe('push')

    const verifier = join(bridgeRoot, 'verify')
    git(bridgeRoot, ['clone', 'proj1.git', 'verify'])
    await expect(readText(join(verifier, 'main.tex'))).resolves.toBe('Hello edited\n')
  })

  it('reports a clean failure for a bogus remote', { timeout: 30_000 }, async () => {
    const transport = new OverleafGitTransport('https://git.invalid.example')
    const mirrorPath = await makeTempDir('dsh-overleaf-bogus-')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(mirrorPath, { recursive: true })
    await expect(transport.clone('deadbeef', mirrorPath, LOCAL_TOKEN)).rejects.toThrow(/exited/)
  })
})

describe('apiSnapshotPull', () => {
  it('replaces the worktree with the snapshot and commits it', { timeout: 60_000 }, async () => {
    if (process.platform !== 'win32') return // fixture zip is built with Compress-Archive
    const mirrorPath = await makeTempDir('dsh-overleaf-snap-')
    git(mirrorPath, ['init', '-b', 'main'])
    await writeFile(join(mirrorPath, 'old.tex'), 'to be removed\n')
    git(mirrorPath, ['add', '.'])
    git(mirrorPath, ['config', 'user.name', 'test'])
    git(mirrorPath, ['config', 'user.email', 'test@local'])
    git(mirrorPath, ['commit', '-m', 'initial'])

    // Build a snapshot zip whose content differs (adds new.tex, drops old.tex).
    const staging = await makeTempDir('dsh-overleaf-zipstage-')
    await writeFile(join(staging, 'new.tex'), 'fresh content\n')
    const zipPath = join(staging, '..', 'dsh-overleaf-zipstage-snapshot.zip')
    const compress = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zipPath}' -Force`,
    ], { windowsHide: true })
    if (compress.status !== 0) throw new Error(`Compress-Archive failed: ${compress.stderr}`)
    const zip = await readFile(zipPath)

    const binding: OverleafBinding = { projectId: 'p', projectName: 'p', mirrorPath, transport: 'api' }
    const message = await apiSnapshotPull(binding, zip, LOCAL_TOKEN)
    expect(message).toContain('committed')

    await expect(stat(join(mirrorPath, 'old.tex'))).rejects.toThrow()
    await expect(readText(join(mirrorPath, 'new.tex'))).resolves.toBe('fresh content\n')
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: mirrorPath, encoding: 'utf8' })
    expect(status.stdout.trim()).toBe('')
  }, 30_000)

  it('refuses to overwrite uncommitted local changes', { timeout: 30_000 }, async () => {
    const mirrorPath = await makeTempDir('dsh-overleaf-dirty-')
    git(mirrorPath, ['init', '-b', 'main'])
    await writeFile(join(mirrorPath, 'local.tex'), 'precious\n')
    git(mirrorPath, ['add', '.'])
    git(mirrorPath, ['config', 'user.name', 'test'])
    git(mirrorPath, ['config', 'user.email', 'test@local'])
    git(mirrorPath, ['commit', '-m', 'initial'])
    await writeFile(join(mirrorPath, 'local.tex'), 'edited but uncommitted\n')

    const binding: OverleafBinding = { projectId: 'p', projectName: 'p', mirrorPath, transport: 'api' }
    await expect(apiSnapshotPull(binding, Buffer.from('PK\x03\x04'), LOCAL_TOKEN))
      .rejects.toThrow(/uncommitted changes/)
    await expect(readFile(join(mirrorPath, 'local.tex'), 'utf8')).resolves.toBe('edited but uncommitted\n')
  })
})
