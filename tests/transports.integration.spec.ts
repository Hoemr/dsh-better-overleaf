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
import { pickEntryTex } from '../src/compile.ts'
import { writeBinding } from '../src/paths.ts'

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
    const bridgeRoot = await makeTempDir('dsh-better-overleaf-bridge-')
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
    const mirrorPath = await makeTempDir('dsh-better-overleaf-mirror-')
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
    const mirrorPath = await makeTempDir('dsh-better-overleaf-bogus-')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(mirrorPath, { recursive: true })
    await expect(transport.clone('deadbeef', mirrorPath, LOCAL_TOKEN)).rejects.toThrow(/exited/)
  })
})

describe('apiSnapshotPull', () => {
  it('replaces the worktree with the snapshot and commits it', { timeout: 60_000 }, async () => {
    if (process.platform !== 'win32') return // fixture zip is built with Compress-Archive
    const mirrorPath = await makeTempDir('dsh-better-overleaf-snap-')
    git(mirrorPath, ['init', '-b', 'main'])
    await writeFile(join(mirrorPath, 'old.tex'), 'to be removed\n')
    git(mirrorPath, ['add', '.'])
    git(mirrorPath, ['config', 'user.name', 'test'])
    git(mirrorPath, ['config', 'user.email', 'test@local'])
    git(mirrorPath, ['commit', '-m', 'initial'])

    // Build a snapshot zip whose content differs (adds new.tex, drops old.tex).
    const staging = await makeTempDir('dsh-better-overleaf-zipstage-')
    await writeFile(join(staging, 'new.tex'), 'fresh content\n')
    const zipPath = join(staging, '..', 'dsh-better-overleaf-zipstage-snapshot.zip')
    const compress = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zipPath}' -Force`,
    ], { windowsHide: true })
    if (compress.status !== 0) throw new Error(`Compress-Archive failed: ${compress.stderr}`)
    const zip = await readFile(zipPath)

    const binding: OverleafBinding = { projectId: 'p', projectName: 'p', mirrorPath, transport: 'api' }
    // A bound mirror carries the binding file; the snapshot refresh must keep it.
    await writeBinding(binding)
    const message = await apiSnapshotPull(binding, zip, LOCAL_TOKEN)
    expect(message).toContain('committed')

    await expect(stat(join(mirrorPath, 'old.tex'))).rejects.toThrow()
    await expect(readText(join(mirrorPath, 'new.tex'))).resolves.toBe('fresh content\n')
    // The binding survived the wipe (this exact loss broke sync/compile before).
    await expect(readText(join(mirrorPath, '.overleaf.json'))).resolves.toContain('"p"')
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: mirrorPath, encoding: 'utf8' })
    expect(status.stdout.trim()).toBe('')
  }, 30_000)

  it('refuses to overwrite uncommitted local changes', { timeout: 30_000 }, async () => {
    const mirrorPath = await makeTempDir('dsh-better-overleaf-dirty-')
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

describe('smart pull/push with rebase semantics', () => {
  it('fast-forwards a clean mirror and reports the position', { timeout: 120_000 }, async () => {
    const bridgeRoot = await makeTempDir('dsh-better-overleaf-smart1-')
    const bare = join(bridgeRoot, 'proj.git')
    const seed = join(bridgeRoot, 'seed')
    const transport = new OverleafGitTransport(`file:///${bridgeRoot.replaceAll('\\', '/')}`)
    git(bridgeRoot, ['init', '--bare', '-b', 'main', 'proj.git'])
    git(bridgeRoot, ['clone', 'proj.git', 'seed'])
    git(seed, ['config', 'user.name', 'test'])
    git(seed, ['config', 'user.email', 'test@local'])
    await writeFile(join(seed, 'main.tex'), 'v1\n')
    git(seed, ['add', '.'])
    git(seed, ['commit', '-m', 'seed'])
    git(seed, ['push', 'origin', 'HEAD:main'])

    const mirrorPath = await makeTempDir('dsh-better-overleaf-smartmirror1-')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(mirrorPath, { recursive: true })
    await transport.clone('proj', mirrorPath, LOCAL_TOKEN)
    const binding: OverleafBinding = { projectId: 'proj', projectName: 'proj', mirrorPath, transport: 'git' }

    // Up to date: pull is a no-op with a friendly message.
    const upToDate = await transport.smartPull(binding, LOCAL_TOKEN)
    expect(upToDate.message).toContain('已是最新')

    // Upstream moves; clean mirror fast-forwards.
    await writeFile(join(seed, 'other.tex'), 'from overleaf\n')
    git(seed, ['add', '.'])
    git(seed, ['commit', '-m', 'remote change'])
    git(seed, ['push', 'origin', 'HEAD:main'])
    const pulled = await transport.smartPull(binding, LOCAL_TOKEN)
    expect(pulled.message).toContain('快进')
    await expect(readText(join(mirrorPath, 'other.tex'))).resolves.toBe('from overleaf\n')

    // Status reads the new position.
    const status = await transport.readStatus(binding, LOCAL_TOKEN)
    expect(status.ahead).toBe(0)
    expect(status.behind).toBe(0)
    expect(status.dirty).toBe(false)
    expect(status.remoteAvailable ?? true).toBe(true)
  })

  it('auto-commits dirty work, rebases local commits, and reports conflicts cleanly', { timeout: 120_000 }, async () => {
    const bridgeRoot = await makeTempDir('dsh-better-overleaf-smart2-')
    const seed = join(bridgeRoot, 'seed')
    const transport = new OverleafGitTransport(`file:///${bridgeRoot.replaceAll('\\', '/')}`)
    git(bridgeRoot, ['init', '--bare', '-b', 'main', 'proj.git'])
    git(bridgeRoot, ['clone', 'proj.git', 'seed'])
    git(seed, ['config', 'user.name', 'test'])
    git(seed, ['config', 'user.email', 'test@local'])
    await writeFile(join(seed, 'main.tex'), 'base\n')
    git(seed, ['add', '.'])
    git(seed, ['commit', '-m', 'seed'])
    git(seed, ['push', 'origin', 'HEAD:main'])

    const mirrorPath = await makeTempDir('dsh-better-overleaf-smartmirror2-')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(mirrorPath, { recursive: true })
    await transport.clone('proj', mirrorPath, LOCAL_TOKEN)
    git(mirrorPath, ['config', 'user.name', 'test'])
    git(mirrorPath, ['config', 'user.email', 'test@local'])
    const binding: OverleafBinding = { projectId: 'proj', projectName: 'proj', mirrorPath, transport: 'git' }

    // Dirty worktree + new upstream commit: auto-commit then fast-forward.
    await writeFile(join(seed, 'notes.tex'), 'remote notes\n')
    git(seed, ['add', '.'])
    git(seed, ['commit', '-m', 'remote notes'])
    git(seed, ['push', 'origin', 'HEAD:main'])
    await writeFile(join(mirrorPath, 'draft.tex'), 'local draft\n')
    const dirtyPull = await transport.smartPull(binding, LOCAL_TOKEN)
    expect(dirtyPull.committedLocally).toBe(true)
    await expect(readText(join(mirrorPath, 'notes.tex'))).resolves.toBe('remote notes\n')
    await expect(readText(join(mirrorPath, 'draft.tex'))).resolves.toBe('local draft\n')

    // Local commit + remote commit (disjoint files): rebase keeps both.
    await writeFile(join(mirrorPath, 'mine.tex'), 'mine\n')
    git(mirrorPath, ['add', '.'])
    git(mirrorPath, ['commit', '-m', 'local commit'])
    await writeFile(join(seed, 'theirs.tex'), 'theirs\n')
    git(seed, ['add', '.'])
    git(seed, ['commit', '-m', 'remote commit'])
    git(seed, ['push', 'origin', 'HEAD:main'])
    const rebased = await transport.smartPull(binding, LOCAL_TOKEN)
    expect(rebased.message).toContain('变基')
    await expect(readText(join(mirrorPath, 'theirs.tex'))).resolves.toBe('theirs\n')
    await expect(readText(join(mirrorPath, 'mine.tex'))).resolves.toBe('mine\n')

    // True conflict: both sides touch the same file; abort keeps local state.
    await writeFile(join(mirrorPath, 'main.tex'), 'local version\n')
    git(mirrorPath, ['add', '.'])
    git(mirrorPath, ['commit', '-m', 'conflicting local'])
    await writeFile(join(seed, 'main.tex'), 'remote version\n')
    git(seed, ['add', '.'])
    git(seed, ['commit', '-m', 'conflicting remote'])
    git(seed, ['push', 'origin', 'HEAD:main'])
    await expect(transport.smartPull(binding, LOCAL_TOKEN)).rejects.toThrow(/冲突/)
    await expect(readText(join(mirrorPath, 'main.tex'))).resolves.toBe('local version\n')
    // The aborted rebase leaves the local commit intact; ahead == 1 again.
    const status = await transport.readStatus(binding, LOCAL_TOKEN)
    expect(status.ahead).toBeGreaterThanOrEqual(1)
  })

  it('push refuses when the remote moved, succeeds otherwise', { timeout: 120_000 }, async () => {
    const bridgeRoot = await makeTempDir('dsh-better-overleaf-smart3-')
    const seed = join(bridgeRoot, 'seed')
    const transport = new OverleafGitTransport(`file:///${bridgeRoot.replaceAll('\\', '/')}`)
    git(bridgeRoot, ['init', '--bare', '-b', 'main', 'proj.git'])
    git(bridgeRoot, ['clone', 'proj.git', 'seed'])
    git(seed, ['config', 'user.name', 'test'])
    git(seed, ['config', 'user.email', 'test@local'])
    await writeFile(join(seed, 'main.tex'), 'base\n')
    git(seed, ['add', '.'])
    git(seed, ['commit', '-m', 'seed'])
    git(seed, ['push', 'origin', 'HEAD:main'])

    const mirrorPath = await makeTempDir('dsh-better-overleaf-smartmirror3-')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(mirrorPath, { recursive: true })
    await transport.clone('proj', mirrorPath, LOCAL_TOKEN)
    git(mirrorPath, ['config', 'user.name', 'test'])
    git(mirrorPath, ['config', 'user.email', 'test@local'])
    const binding: OverleafBinding = { projectId: 'proj', projectName: 'proj', mirrorPath, transport: 'git' }

    // Remote moves first; push must refuse with the pull-first hint.
    await writeFile(join(seed, 'new.tex'), 'ahead\n')
    git(seed, ['add', '.'])
    git(seed, ['commit', '-m', 'remote moved'])
    git(seed, ['push', 'origin', 'HEAD:main'])
    await writeFile(join(mirrorPath, 'local.tex'), 'local\n')
    await expect(transport.smartPush(binding, LOCAL_TOKEN)).rejects.toThrow(/拉取更新/)

    // After pulling, the push publishes everything.
    await transport.smartPull(binding, LOCAL_TOKEN)
    const pushed = await transport.smartPush(binding, LOCAL_TOKEN)
    expect(pushed.direction).toBe('push')
    // The push landed on the bare bridge; the seed clone sees it after a pull.
    git(seed, ['pull', 'origin', 'main'])
    await expect(readText(join(seed, 'local.tex'))).resolves.toBe('local\n')
  })
})

describe('compile entry selection', () => {
  it('prefers main.tex, then a documentclass file, then the first .tex', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const dir = await makeTempDir('dsh-better-overleaf-entry-')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'chapter1.tex'), 'section{}\n')
    await writeFile(join(dir, 'chapter2.tex'), 'section{}\n')
    await expect(pickEntryTex(dir)).resolves.toBe('chapter1.tex')
    await writeFile(join(dir, 'thesis.tex'), '\\documentclass{article}\nbegin{document}\n')
    await expect(pickEntryTex(dir)).resolves.toBe('thesis.tex')
  })
})
