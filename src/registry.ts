/**
 * Host-side mirror registry and auto-sync policy store, persisted under
 * `~/.dsh/plugin-data/dsh-better-overleaf/bindings.json`. The `.overleaf.json` binding
 * files stay the source of truth per mirror; this registry only indexes them so
 * the background scheduler can find mirrors without scanning workspaces, and
 * records the last-sync timestamps the tab surfaces as 「上次同步」.
 * @module dsh-better-overleaf/registry
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_AUTO_SYNC_POLICY } from './types.ts'
import type { OverleafAutoSyncPolicy } from './types.ts'

/** Persisted registry shape (versioned for forward migrations). */
interface RegistryFile {
  version: 1
  /** One entry per mirror ever bound on this machine. */
  bindings: RegistryBinding[]
  /** Global auto-sync policy. */
  policy: OverleafAutoSyncPolicy
  /** Last completed sync (pull or push) per mirror path. */
  lastSync: Record<string, string>
}

/** One indexed mirror. */
export interface RegistryBinding {
  /** Bound Overleaf project id. */
  projectId: string
  /** Project display name captured at bind time. */
  projectName: string
  /** Absolute mirror directory. */
  mirrorPath: string
  /** Workspace the mirror was bound from (informational). */
  workspacePath?: string
}

/** Empty registry with the default policy. */
function emptyRegistry(): RegistryFile {
  return { version: 1, bindings: [], policy: { ...DEFAULT_AUTO_SYNC_POLICY }, lastSync: {} }
}

/**
 * Registry file location. `DSH_HOME` overrides the home root, matching the
 * host's own environment convention (and keeping tests off the real home).
 */
function registryPath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-data', 'dsh-better-overleaf', 'bindings.json')
}

/** Load the registry, repairing any malformed or missing file. */
export async function loadRegistry(): Promise<RegistryFile> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(registryPath(), 'utf8'))
  } catch {
    return emptyRegistry()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyRegistry()
  const raw = parsed as Partial<RegistryFile>
  const bindings = Array.isArray(raw.bindings)
    ? raw.bindings.filter((entry): entry is RegistryBinding =>
        typeof entry === 'object' && entry !== null
        && typeof (entry as RegistryBinding).mirrorPath === 'string'
        && typeof (entry as RegistryBinding).projectId === 'string')
    : []
  const policy = typeof raw.policy === 'object' && raw.policy !== null
    ? { ...DEFAULT_AUTO_SYNC_POLICY, ...(raw.policy as Partial<OverleafAutoSyncPolicy>) }
    : { ...DEFAULT_AUTO_SYNC_POLICY }
  const lastSync = typeof raw.lastSync === 'object' && raw.lastSync !== null
    ? Object.fromEntries(
        Object.entries(raw.lastSync as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : {}
  return { version: 1, bindings, policy, lastSync }
}

/** Persist one registry update atomically enough (single writer: the service). */
async function saveRegistry(registry: RegistryFile): Promise<void> {
  const path = registryPath()
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
}

/** Add or refresh one mirror entry (no-op when already indexed). */
export async function upsertRegistryBinding(binding: RegistryBinding): Promise<void> {
  const registry = await loadRegistry()
  const existing = registry.bindings.find(entry => entry.mirrorPath === binding.mirrorPath)
  if (existing !== undefined) {
    existing.projectId = binding.projectId
    existing.projectName = binding.projectName
    if (binding.workspacePath !== undefined) existing.workspacePath = binding.workspacePath
  } else {
    registry.bindings.push({ ...binding })
  }
  await saveRegistry(registry)
}

/** Drop one mirror from the index (unbind / vanished directory). */
export async function removeRegistryBinding(mirrorPath: string): Promise<void> {
  const registry = await loadRegistry()
  const next = registry.bindings.filter(entry => entry.mirrorPath !== mirrorPath)
  if (next.length === registry.bindings.length) return
  delete registry.lastSync[mirrorPath]
  await saveRegistry({ ...registry, bindings: next })
}

/** Record a completed sync for one mirror. */
export async function markSynced(mirrorPath: string, when = new Date().toISOString()): Promise<void> {
  const registry = await loadRegistry()
  registry.lastSync[mirrorPath] = when
  await saveRegistry(registry)
}

/** Update the auto-sync policy. */
export async function savePolicy(policy: OverleafAutoSyncPolicy): Promise<void> {
  const registry = await loadRegistry()
  registry.policy = policy
  await saveRegistry(registry)
}
