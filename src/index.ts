/**
 * dsh-overleaf package root. The default export is the Cordis Service class
 * the web composition mounts as the `overleaf` row; the class provides
 * `ctx.overleaf` and owns the /overleaf route surface.
 * @module dsh-overleaf
 */
export { default, name, inject, Config, OverleafService } from './service.ts'
export type {
  OverleafBinding, OverleafLoginResult, OverleafProject, OverleafStatus, OverleafSyncDirection,
  OverleafSyncResult, OverleafTransportKind, OverleafWireResponse, OverleafWorkspaceBindings,
} from './types.ts'
export { OVERLEAF_COOKIE, OVERLEAF_GIT_TOKEN } from './credentials.ts'
export {
  BINDING_FILENAME, MIRRORS_DIRNAME, listWorkspaceBindings, readBinding, removeBinding,
  safeMirrorName, writeBinding,
} from './paths.ts'
export {
  OverleafApiTransport, OverleafGitTransport, apiSnapshotPull, extractZip, readZipFile, runGit,
} from './transports.ts'
export type { OverleafSession } from './transports.ts'
export { GitExitError } from './transports.ts'
export { loginWithPlaywright } from './login-cdp.ts'
export type { LoginOptions, OverleafBrowserChannel } from './login-cdp.ts'
