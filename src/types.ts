/**
 * Shared dsh-better-overleaf value types. This module stays browser-safe: no node
 * imports, no service identity — the client bundle inlines it and the host
 * uses the same source as the wire contract.
 */

/** One Overleaf project returned by the API transport. */
export interface OverleafProject {
  /** Overleaf project id. */
  id: string
  /** Display name from Overleaf. */
  name: string
  /** Last-updated timestamp from Overleaf, when the API reports one. */
  updatedAt?: string
}

/**
 * The two sync transports the host provider can run. `git` uses the official
 * per-project git bridge (two-way); `api` uses cookie-authenticated website
 * endpoints (project list always; snapshot pull as a free-account fallback).
 */
export type OverleafTransportKind = 'git' | 'api'

/**
 * One local mirror bound to one Overleaf project. The mirror is a real git
 * repository under `<workspace>/overleaf/<name>/`, so dsh-better-sidebar's
 * explorer, editor, previewers, and Git panel operate on it directly.
 */
export interface OverleafBinding {
  /** Bound Overleaf project id. */
  projectId: string
  /** Project display name captured at bind time. */
  projectName: string
  /** Absolute mirror directory carrying the binding file. */
  mirrorPath: string
  /** Transport used for sync; `auto` resolves through the service. */
  transport: OverleafTransportKind | 'auto'
}

/** Current account state plus one workspace's known mirrors. */
export interface OverleafStatus {
  /** Whether a direct-CDP login has stored an Overleaf cookie. */
  loggedIn: boolean
  /** Whether a git credential is stored. */
  gitConfigured: boolean
  /** Default transport used when a binding says `auto`. */
  transport: OverleafTransportKind | 'auto'
}

/** Bindings found under one workspace's `overleaf/` directory. */
export interface OverleafWorkspaceBindings {
  /** Absolute workspace directory that was scanned. */
  workspacePath: string
  /** One entry per mirror directory carrying a binding file. */
  bindings: OverleafBinding[]
}

/** Sync direction requested by the tab. */
export type OverleafSyncDirection = 'pull' | 'push'

/**
 * One completed sync operation. `conflictFiles` is present only when a rebase
 * stopped on conflicts (the mirror is left untouched on the pre-pull commit);
 * `committedLocally` reports the auto-commit of pending local edits.
 */
export interface OverleafSyncResult {
  /** The direction that ran. */
  direction: OverleafSyncDirection
  /** Bound project id. */
  projectId: string
  /** Absolute mirror directory. */
  mirrorPath: string
  /** Transport that performed the sync. */
  transport: OverleafTransportKind
  /** Human-readable summary for the tab. */
  message: string
  /** Files that conflicted during the rebase (absent when none). */
  conflictFiles?: string[]
  /** Whether pending local edits were auto-committed before the sync. */
  committedLocally?: boolean
  /** Post-sync position relative to the remote (absent for API pulls). */
  ahead?: number
  /** Post-sync commits still to pull (absent for API pulls). */
  behind?: number
}

/**
 * Live position of one mirror relative to its Overleaf remote, produced by
 * `/overleaf/remote-status` (fetch + rev-list counts).
 */
export interface OverleafRemoteStatus {
  /** Bound project id. */
  projectId: string
  /** Absolute mirror directory. */
  mirrorPath: string
  /** Transport that status was resolved through (`api` reports a limited shape). */
  transport: OverleafTransportKind
  /** Current branch name (`master` for Overleaf mirrors). */
  branch: string
  /** Local commits not on the remote. */
  ahead: number
  /** Remote commits not pulled yet. */
  behind: number
  /** Both sides moved since the merge base — a plain fast-forward is impossible. */
  diverged: boolean
  /** Whether the worktree has uncommitted changes. */
  dirty: boolean
  /** Uncommitted file count when dirty. */
  dirtyCount: number
  /** ISO timestamp of the newest remote commit (git transport only). */
  remoteCommitTime?: string
  /** ISO timestamp of the newest local commit. */
  localCommitTime?: string
  /** ISO timestamp of the last completed sync toward this remote, if tracked. */
  lastSyncTime?: string
  /** API mirrors carry no remote: status degrades to local-only facts. */
  remoteAvailable: boolean
}

/**
 * Automatic background sync policy. `autoPullInterval` drives the host-side
 * scheduler; auto-push is off by default because it may publish work the AI
 * session is still writing.
 */
export interface OverleafAutoSyncPolicy {
  /** Pull cadence: `off` keeps sync fully manual. */
  autoPullInterval: 'off' | '5m' | '15m' | '30m' | '1h'
  /** Push pending local commits on the same cadence (default off). */
  autoPush: boolean
  /** Commit pending local edits automatically before pull/push (default on). */
  autoCommitLocal: boolean
}

/** Default policy: manual sync, auto-commit enabled for explicit actions. */
export const DEFAULT_AUTO_SYNC_POLICY: OverleafAutoSyncPolicy = {
  autoPullInterval: 'off',
  autoPush: false,
  autoCommitLocal: true,
}

/** Milliseconds of one auto-sync interval tier. */
export const AUTO_PULL_INTERVAL_MS: Record<OverleafAutoSyncPolicy['autoPullInterval'], number> = {
  off: 0,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
}

/** One completed local LaTeX build. */
export interface OverleafCompileResult {
  /** Whether latexmk exited successfully and produced a PDF. */
  ok: boolean
  /** Absolute path of the produced PDF (main entry's sibling). */
  pdfPath?: string
  /** Entry .tex file that was compiled. */
  entryFile: string
  /** Exit code of latexmk. */
  exitCode: number | null
  /** Tail of the combined build output (diagnostics live here). */
  logTail: string
  /** Wall-clock duration in milliseconds. */
  durationMs: number
}

/** Browser wire envelope for every /overleaf route. */
export type OverleafWireResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

/** Result of one login attempt. */
export type OverleafLoginResult =
  | { kind: 'automatic' }
  | { kind: 'manual'; loginUrl: string; instructions: string }
