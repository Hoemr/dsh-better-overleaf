/**
 * Mirror-path and binding-file helpers. One binding lives inside its mirror
 * directory as `.overleaf.json`; the file is auto-appended to the mirror's
 * `.git/info/exclude` so better-sidebar's Git panel never shows it as noise.
 * @module dsh-overleaf/paths
 */
import { mkdir, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OverleafBinding } from './types.ts'

/** Binding file name inside one mirror directory. */
export const BINDING_FILENAME = '.overleaf.json'

/** Subdirectory of a workspace that holds all Overleaf mirrors. */
export const MIRRORS_DIRNAME = 'overleaf'

/** Read one mirror's binding file, or undefined when absent/malformed-loose. */
export async function readBinding(mirrorPath: string): Promise<OverleafBinding | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(mirrorPath, BINDING_FILENAME), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`overleaf: binding file at ${mirrorPath} is not valid JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const binding = parsed as Partial<OverleafBinding>
  if (typeof binding.projectId !== 'string' || binding.projectId === '') return undefined
  return {
    projectId: binding.projectId,
    projectName: typeof binding.projectName === 'string' ? binding.projectName : binding.projectId,
    mirrorPath,
    transport: binding.transport === 'api' || binding.transport === 'git' ? binding.transport : 'auto',
  }
}

/** Write one mirror's binding file and keep it out of `git status` noise. */
export async function writeBinding(binding: OverleafBinding): Promise<void> {
  await writeFile(
    join(binding.mirrorPath, BINDING_FILENAME),
    `${JSON.stringify({ ...binding, mirrorPath: undefined }, null, 2)}\n`,
    'utf8',
  )
  // Local-only exclude: never tracked, never shown as an untracked row.
  await appendFile(join(binding.mirrorPath, '.git', 'info', 'exclude'), `${BINDING_FILENAME}\n`, 'utf8')
    .catch(() => undefined)
}

/** Remove one mirror's binding file; absent files are an idempotent no-op. */
export async function removeBinding(mirrorPath: string): Promise<boolean> {
  try {
    await rm(join(mirrorPath, BINDING_FILENAME))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * List every binding under `<workspace>/overleaf/*`. Directories without a
 * readable binding file are skipped, so foreign folders never break the scan.
 */
export async function listWorkspaceBindings(workspacePath: string): Promise<OverleafBinding[]> {
  const mirrorsDir = join(workspacePath, MIRRORS_DIRNAME)
  let entries: string[]
  try {
    entries = await readdir(mirrorsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const bindings = await Promise.all(entries.map(entry => readBinding(join(mirrorsDir, entry))))
  return bindings.filter((binding): binding is OverleafBinding => binding !== undefined)
}

/** Filesystem-hostile characters collapsed when deriving a mirror name. */
export function safeMirrorName(projectName: string, projectId: string): string {
  const cleaned = projectName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 64)
    .trim()
  return cleaned === '' ? `project-${projectId.slice(0, 8)}` : cleaned
}

/** Create `<workspace>/overleaf/<name>` (deduplicated with ` (n)` suffixes). */
export async function allocateMirrorDir(workspacePath: string, name: string): Promise<string> {
  const base = join(workspacePath, MIRRORS_DIRNAME, name)
  let candidate = base
  for (let suffix = 2; await exists(candidate); suffix += 1) {
    candidate = `${base} (${suffix})`
  }
  await mkdir(candidate, { recursive: true })
  return candidate
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    // The path exists but is a file (readdir EISDIR/EINVAL) — treat as taken.
    return true
  }
}
