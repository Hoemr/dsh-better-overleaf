/**
 * Registry persistence tests against a throwaway DSH_HOME. Covers indexing,
 * upsert-merge semantics, sync timestamps, and removal.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRegistry, markSynced, removeRegistryBinding, savePolicy, upsertRegistryBinding } from '../src/registry.ts'
import { DEFAULT_AUTO_SYNC_POLICY } from '../src/types.ts'

const tempDirs: string[] = []

afterEach(async () => {
  delete process.env.DSH_HOME
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }).catch(() => undefined)))
})

describe('mirror registry persistence', () => {
  it('indexes bindings, merges upserts, records sync time, and removes entries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-better-overleaf-registry-'))
    tempDirs.push(home)
    process.env.DSH_HOME = home

    await expect(loadRegistry()).resolves.toMatchObject({ version: 1, bindings: [] })

    const mirrorA = join(home, 'overleaf', 'proj')
    const mirrorB = join(home, 'overleaf', 'other')
    await upsertRegistryBinding({ projectId: 'p1', projectName: 'proj', mirrorPath: mirrorA })
    await upsertRegistryBinding({ projectId: 'p2', projectName: 'other', mirrorPath: mirrorB })
    // Upsert with the same path refreshes in place instead of duplicating.
    await upsertRegistryBinding({ projectId: 'p1', projectName: 'proj-renamed', mirrorPath: mirrorA })

    let registry = await loadRegistry()
    expect(registry.bindings).toHaveLength(2)
    expect(registry.bindings.find(entry => entry.mirrorPath === mirrorA)?.projectName).toBe('proj-renamed')

    await markSynced(mirrorA, '2026-08-30T00:00:00Z')
    registry = await loadRegistry()
    expect(registry.lastSync[mirrorA]).toBe('2026-08-30T00:00:00Z')

    await removeRegistryBinding(mirrorA)
    registry = await loadRegistry()
    expect(registry.bindings).toHaveLength(1)
    expect(registry.lastSync[mirrorA]).toBeUndefined()
  })

  it('persists the auto-sync policy and repairs malformed files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-better-overleaf-policy-'))
    tempDirs.push(home)
    process.env.DSH_HOME = home

    await savePolicy({ autoPullInterval: '15m', autoPush: true, autoCommitLocal: false })
    await expect(loadRegistry()).resolves.toMatchObject({
      policy: { autoPullInterval: '15m', autoPush: true, autoCommitLocal: false },
    })

    const { mkdir, writeFile } = await import('node:fs/promises')
    const dataDir = join(home, 'plugin-data', 'dsh-better-overleaf')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'bindings.json'), '{not json at all', 'utf8')
    // Malformed file degrades to an empty registry with the default policy.
    await expect(loadRegistry()).resolves.toMatchObject({ version: 1, policy: DEFAULT_AUTO_SYNC_POLICY })
  })
})
