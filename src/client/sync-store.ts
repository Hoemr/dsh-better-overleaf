/**
 * Module-level sync snapshot store. The tab component writes fresh
 * remote-status numbers as it polls; the tab-strip badge reads them from
 * outside React, so the badge stays live without re-render plumbing.
 */

/** Per-workspace aggregate of the mirrors bound under it. */
export interface WorkspaceSyncSummary {
  /** Commits to pull across the workspace's mirrors. */
  behind: number
  /** Commits to push across the workspace's mirrors. */
  ahead: number
  /** Mirrors carrying uncommitted changes. */
  dirty: number
}

const EMPTY: WorkspaceSyncSummary = { behind: 0, ahead: 0, dirty: 0 }

const byWorkspace = new Map<string, WorkspaceSyncSummary>()
const listeners = new Set<() => void>()

/** Read one workspace's summary (zeroed when unknown). */
export function summaryFor(workspacePath: string | undefined): WorkspaceSyncSummary {
  if (workspacePath === undefined || workspacePath === '') return EMPTY
  return byWorkspace.get(workspacePath) ?? EMPTY
}

/** Write one mirror's numbers into its workspace aggregate. */
export function reportMirror(workspacePath: string | undefined, status: {
  ahead: number
  behind: number
  dirty: boolean
}): void {
  if (workspacePath === undefined || workspacePath === '') return
  const previous = byWorkspace.get(workspacePath) ?? { behind: 0, ahead: 0, dirty: 0 }
  const next = {
    behind: previous.behind,
    ahead: previous.ahead,
    dirty: previous.dirty,
  }
  // Recomputed wholesale per mirror via a full refresh below; single-mirror
  // updates add to the aggregate the manager maintains.
  next.behind += status.behind
  next.ahead += status.ahead
  if (status.dirty) next.dirty += 1
  byWorkspace.set(workspacePath, next)
  for (const listener of listeners) listener()
}

/** Reset one workspace's aggregate before a full refresh pass. */
export function resetWorkspace(workspacePath: string | undefined): void {
  if (workspacePath === undefined || workspacePath === '') return
  byWorkspace.delete(workspacePath)
  for (const listener of listeners) listener()
}

/** Subscribe to aggregate changes; returns the disposer. */
export function subscribeSync(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
