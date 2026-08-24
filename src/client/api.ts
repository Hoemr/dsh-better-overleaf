/**
 * Browser wire client for the host /overleaf routes. Every call posts JSON and
 * decodes the shared `{ ok, value | error }` envelope.
 */
import type {
  OverleafBinding, OverleafLoginResult, OverleafProject, OverleafStatus, OverleafSyncDirection,
  OverleafSyncResult, OverleafWireResponse, OverleafWorkspaceBindings,
} from '../types.ts'

/** Transport error used when fetch or JSON decoding fails. */
const TRANSPORT_ERROR = { code: 'overleaf-transport', message: 'overleaf route unavailable' }

/** POST one JSON payload and decode the shared wire envelope. */
async function post<T>(path: string, payload: Record<string, unknown>): Promise<OverleafWireResponse<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  }
  try {
    const envelope: unknown = await response.json()
    if (typeof envelope !== 'object' || envelope === null) return { ok: false, error: TRANSPORT_ERROR }
    return envelope as OverleafWireResponse<T>
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  }
}

/** Throw the wire error or return the value. */
async function unwrap<T>(response: OverleafWireResponse<T>): Promise<T> {
  if (!response.ok) throw new Error(response.error.message)
  return response.value
}

/** Client API over the host Overleaf service. */
export const overleafApi = {
  /** Read account state plus one workspace's known mirrors. */
  status: async (workspacePath?: string) =>
    unwrap(await post<OverleafStatus & { bindings?: OverleafBinding[] }>('/overleaf/status', { ...(workspacePath === undefined ? {} : { workspacePath }) })),
  /** List Overleaf projects. */
  projects: async () => unwrap(await post<OverleafProject[]>('/overleaf/projects', {})),
  /** List mirrors bound under one workspace. */
  bindings: async (workspacePath: string) =>
    unwrap(await post<OverleafWorkspaceBindings>('/overleaf/bindings', { workspacePath })),
  /** Start the host-side browser login. */
  login: async (browserChannel?: string, browserPath?: string) =>
    unwrap(await post<OverleafLoginResult>('/overleaf/login', {
      ...(browserChannel === undefined ? {} : { browserChannel }),
      ...(browserPath === undefined || browserPath.trim() === '' ? {} : { browserPath }),
    })),
  /** Store a cookie pasted from a browser the host cannot automate. */
  saveCookie: async (cookie: string) => unwrap(await post<void>('/overleaf/cookie', { cookie })),
  /** Store the git-bridge credential used as the https password (username `git`). */
  saveGitToken: async (token: string) => unwrap(await post<void>('/overleaf/git-token', { token })),
  /** Bind one workspace to one Overleaf project and seed the mirror. */
  bind: async (workspacePath: string, projectId: string, transport?: string, name?: string) =>
    unwrap(await post<OverleafBinding>('/overleaf/bind', {
      workspacePath,
      projectId,
      ...(transport === undefined ? {} : { transport }),
      ...(name === undefined || name.trim() === '' ? {} : { name }),
    })),
  /** Remove one mirror's binding file. */
  unbind: async (mirrorPath: string) => unwrap(await post<boolean>('/overleaf/unbind', { mirrorPath })),
  /** Pull or push one bound mirror. */
  sync: async (mirrorPath: string, direction: OverleafSyncDirection) =>
    unwrap(await post<OverleafSyncResult>('/overleaf/sync', { mirrorPath, direction })),
}
