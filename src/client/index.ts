/**
 * dsh-better-overleaf browser half. Registers the Overleaf tab plus the
 * pdf.js-based PDF viewer with the optional dsh-better-sidebar registry. The
 * tab badge mirrors the live sync aggregate (pending pull + push + dirty
 * mirrors) from the module sync store. Without better-sidebar the plugin
 * activates but contributes no surface, matching the optional peer contract.
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { clearActiveBetterSidebar, registerBetterSidebarTab } from './contract.ts'
import type { BetterSidebarRegistry } from './contract.ts'
import { OverleafManager } from './OverleafManager.tsx'
import { OverleafIcon, PdfIcon } from './icons.tsx'
import { PdfViewer } from './PdfViewer.tsx'
import { summaryFor } from './sync-store.ts'

export type { BetterSidebarRegistry, OverleafTabDefinition } from './contract.ts'
export { OverleafManager } from './OverleafManager.tsx'
export { PdfViewer } from './PdfViewer.tsx'

/** Stable client plugin name. */
export const name = 'dsh-better-overleaf-client'

/** Find the better-sidebar tab registry across its supported service keys. */
function findBetterSidebar(ctx: Context): BetterSidebarRegistry | undefined {
  const direct = ctx.get('betterSidebar') as BetterSidebarRegistry | undefined
  if (direct !== undefined) return direct
  const kebab = ctx.get('better-sidebar') as BetterSidebarRegistry | undefined
  if (kebab !== undefined) return kebab
  return ctx.get('dsh-better-sidebar') as BetterSidebarRegistry | undefined
}

/** Service key dsh-better-sidebar publishes; cast because this repo builds without its type merge. */
const BETTER_SIDEBAR_KEYS = ['betterSidebar'] as const

/**
 * Register the Overleaf tab once the optional better-sidebar service appears.
 * `ctx.inject` keeps the registration waiting instead of probing at apply time,
 * so either activation order works and a missing optional peer contributes no
 * surface.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  let registered = false
  const register = (betterCtx: Context): void => {
    if (registered) return
    const betterSidebar = findBetterSidebar(betterCtx)
    if (betterSidebar === undefined) return
    registered = true
    betterCtx.effect(
      () => {
        const disposeTab = registerBetterSidebarTab(betterSidebar, {
          id: 'overleaf',
          title: 'Overleaf',
          order: 60,
          single: true,
          icon: (size: number) => createElement(OverleafIcon, { size }),
          component: OverleafManager,
          badge: (_tabCtx, scope) => {
            const summary = summaryFor(scope?.cwd)
            const pending = summary.behind + summary.dirty
            return pending > 0 ? pending : summary.ahead > 0 ? summary.ahead : undefined
          },
        })
        const disposeViewer = betterSidebar.registerFileViewer?.({
          id: 'overleaf-pdf',
          title: 'PDF 阅读器（Overleaf）',
          icon: (size: number) => createElement(PdfIcon, { size }),
          exts: ['pdf'],
          priority: 10,
          fetchStrategy: 'mediaUrl',
          component: props => createElement(PdfViewer, {
            ...(props.mediaUrl !== undefined ? { mediaUrl: props.mediaUrl } : {}),
            path: props.path,
            title: props.title,
          }),
        })
        return (): void => {
          clearActiveBetterSidebar()
          disposeViewer?.()
          disposeTab()
        }
      },
      'dsh-better-overleaf: better-sidebar tab + pdf viewer',
    )
  }
  for (const key of BETTER_SIDEBAR_KEYS) {
    ctx.inject([key] as unknown as (keyof Context)[], register)
  }
}
