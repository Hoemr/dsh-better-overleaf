/**
 * Optional dsh-better-sidebar tab-registration contract. The peer is optional:
 * when the better-sidebar row is not mounted this client contributes nothing.
 *
 * This is a structural mirror of `dsh-better-sidebar/client/service`'s
 * `TabDescriptor`/`TabComponentProps`/`BetterSidebarService` subset dsh-overleaf
 * uses, so the repository still builds when the optional peer is not installed.
 * Aligned with dsh-better-sidebar 0.13.x / 0.14.x.
 */
import type { ReactNode } from 'react'

/** Structural mirror of better-sidebar's session scope. */
export interface SidebarSessionScope {
  /** The conversation id the sidebar instance belongs to. */
  sessionId: string
  /** The session's working directory when known. */
  cwd?: string
}

/** Structural mirror of better-sidebar's minted tab record. */
export interface SidebarTabRecord {
  /** Minted tab id. */
  id: string
  /** Tab type (= descriptor id). */
  type: string
  /** Display title. */
  title: string
}

/** Structural mirror of better-sidebar's `TabComponentProps`. */
export interface BetterSidebarTabProps {
  /** The client Cordis context of the sidebar session. */
  ctx: unknown
  /** The sidebar store; opaque to dsh-overleaf. */
  store: unknown
  /** The session scope this tab instance belongs to. */
  scope: SidebarSessionScope
  /** The minted tab record (`id`/`type`/`title`). */
  tab: SidebarTabRecord
  /** Whether this tab is active and the panel is open. */
  visible: boolean
}

/** One tab contributed to the better-sidebar workbench. */
export interface OverleafTabDefinition {
  /** Stable tab id; also the opened tab's `type`. */
  id: string
  /** Sidebar label, also used as the default tab title. */
  title: string | (() => string)
  /** `+` menu sort order; lower values sort first. */
  order?: number
  /** Small tab icon shown in the `+` menu and the tab strip. */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** Keep one Overleaf tab per session instead of opening duplicates. */
  single?: boolean
  /** Tab body component; receives the standard tab props and may ignore them. */
  component: (props: BetterSidebarTabProps) => ReactNode
}

/** One `openTab` request (subset). */
export interface OpenTabSeed {
  /** The target tab type. */
  type: string
  /** Title override. */
  title?: string
}

/** The registry service dsh-better-sidebar publishes as `ctx.betterSidebar`. */
export interface BetterSidebarRegistry {
  /** Register one tab descriptor; the returned disposer removes it. */
  registerTab(descriptor: OverleafTabDefinition): () => void
  /** Open (or focus) one tab by type in the given session scope. */
  openTab?(seed: OpenTabSeed, scope?: SidebarSessionScope): void
  /** Open a workspace file in the editor of the given session scope. */
  openFile?(scope: SidebarSessionScope, path: string, title?: string): void
}

/** Module-level handle to the mounted better-sidebar service, if any. */
let activeBetterSidebar: BetterSidebarRegistry | undefined

/**
 * Register one tab descriptor with the mounted better-sidebar service. Also
 * remembers the service module-wide so tab components can call openTab /
 * openFile without re-resolving it from their scoped context.
 * @param registry - the optional peer service.
 * @param tab - the descriptor to register.
 * @returns the tab disposer.
 */
export function registerBetterSidebarTab(registry: BetterSidebarRegistry, tab: OverleafTabDefinition): () => void {
  activeBetterSidebar = registry
  return registry.registerTab(tab)
}

/** Forget the mounted better-sidebar service (peer disposal). */
export function clearActiveBetterSidebar(): void {
  activeBetterSidebar = undefined
}

/** The mounted better-sidebar service, or undefined before it appears. */
export function getActiveBetterSidebar(): BetterSidebarRegistry | undefined {
  return activeBetterSidebar
}
