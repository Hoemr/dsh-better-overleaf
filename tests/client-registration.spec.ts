/**
 * Client-bundle registration tests: load the built `lib/client.js` CJS closure
 * through its ModuleLoader banner with a stubbed `window.__ModuleLoader__`,
 * then drive `apply()` against a fake client context and a fake better-sidebar
 * registry. Verifies the optional-peer contract: no registry, no surface.
 * Run `node node_modules/tsdown/dist/run.mjs` first (tests import lib/).
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

interface LoadedModule {
  id: string
  factory: (require: NodeRequire) => {
    name: string
    apply: (ctx: unknown) => void
  }
}

interface CapturedInject {
  keys: string[]
  register: (betterCtx: unknown) => void
}

interface CapturedTab {
  id: string
  single?: boolean
  component: unknown
}

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))

let loaded: LoadedModule | undefined

beforeAll(async () => {
  expect(existsSync(clientPath), 'lib/client.js missing — run the tsdown build first').toBe(true)
  ;(globalThis as Record<string, unknown>).window = {
    __ModuleLoader__: { load: (module: LoadedModule) => { loaded = module } },
  }
  try {
    await import(clientPath)
  } finally {
    delete (globalThis as Record<string, unknown>).window
  }
})

describe('dsh-better-overleaf client registration', () => {
  it('captures the bundle through the ModuleLoader banner', () => {
    expect(loaded?.id).toBe('dsh-better-overleaf')
  })

  it('registers the Overleaf tab when better-sidebar appears', () => {
    const nodeRequire = createRequire(clientPath)
    const mod = loaded.factory(nodeRequire)
    expect(mod.name).toBe('dsh-better-overleaf-client')

    const injected: CapturedInject[] = []
    const captured: CapturedTab[] = []
    const registry = {
      registerTab: (descriptor: { id: string; single?: boolean; component: unknown }) => {
        captured.push(descriptor)
        return (): void => {}
      },
    }
    const fakeCtx = {
      inject(keys: string[], register: (betterCtx: unknown) => void): void {
        injected.push({ keys, register })
      },
      get(key: string): unknown {
        return key === 'betterSidebar' ? registry : undefined
      },
      effect(fn: () => unknown): unknown {
        return fn()
      },
    }

    // Before better-sidebar mounts: apply only arms the inject waiter.
    mod.apply(fakeCtx)
    expect(captured).toHaveLength(0)
    expect(injected).toHaveLength(1)
    expect(injected[0].keys).toEqual(['betterSidebar'])

    // The optional peer appears: the tab registers exactly once.
    injected[0].register(fakeCtx)
    injected[0].register(fakeCtx)
    expect(captured).toHaveLength(1)
    expect(captured[0].id).toBe('overleaf')
    expect(captured[0].single).toBe(true)
    expect(typeof captured[0].component).toBe('function')
  })

  it('contributes nothing when the peer never resolves', () => {
    const nodeRequire = createRequire(clientPath)
    const mod = loaded.factory(nodeRequire)
    const captured: unknown[] = []
    mod.apply({
      inject(keys: string[], register: (betterCtx: unknown) => void): void {
        register({ get: (): undefined => undefined }) // peer never mounts
      },
      get: (): undefined => undefined,
      effect: (fn: () => unknown) => fn(),
    })
    expect(captured).toHaveLength(0)
  })
})
