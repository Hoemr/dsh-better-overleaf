/**
 * Shared dsh-overleaf value types. This module stays browser-safe: no node
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

/** One completed sync operation. */
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
}

/** Browser wire envelope for every /overleaf route. */
export type OverleafWireResponse<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

/** Result of one login attempt. */
export type OverleafLoginResult =
  | { kind: 'automatic' }
  | { kind: 'manual'; loginUrl: string; instructions: string }
