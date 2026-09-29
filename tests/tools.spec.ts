/**
 * Agent-tool assembly tests: mount OverleafService with mock webServer /
 * credentials / tools providers and assert the four Overleaf tools reach the
 * host tool registry with schemas the installed `@deepseek-ai/dsh-tools`
 * accepts.
 *
 * The host tool dialect is the compatibility surface that fails silently: a
 * `defineTool` definition this build rejects throws inside the `ctx.inject`
 * fork, so the plugin still mounts and every route still works while the model
 * simply never sees the tools. Driving the real `defineTool` and the real
 * `validateArgs` from the installed harness package is what makes a dialect
 * change fail here instead.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { assertObjectJsonSchema, validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OverleafService } from '../src/service.ts'
import type { Config } from '../src/service.ts'

/** The host tool registry, reduced to the `register` seam the plugin uses. */
class MockTools extends Service {
  readonly definitions: ToolDefinition[] = []
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }
  register(definition: ToolDefinition): () => void {
    this.definitions.push(definition)
    return () => {
      const at = this.definitions.indexOf(definition)
      if (at >= 0) this.definitions.splice(at, 1)
    }
  }
}

class MockWebServer extends Service {
  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }
  register(): void {}
}

class MockCredentials extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }
  async describe(): Promise<{ configured: boolean }> {
    return { configured: false }
  }
  async resolve(): Promise<undefined> {
    return undefined
  }
  async set(): Promise<void> {}
}

afterEach(() => {
  vi.restoreAllMocks()
})

/** Mount the service with every provider it injects, tools included. */
async function mount(): Promise<{ ctx: Context; tools: MockTools }> {
  const ctx = new Context()
  await ctx.plugin(MockWebServer)
  await ctx.plugin(MockCredentials)
  await ctx.plugin(MockTools)
  await ctx.plugin(OverleafService, {} as Config)
  return { ctx, tools: ctx.tools as MockTools }
}

describe('Overleaf agent tools', () => {
  it('registers the four Overleaf tools with the host registry', async () => {
    const { tools } = await mount()
    expect(tools.definitions.map(definition => definition.name).sort()).toEqual([
      'overleaf_compile',
      'overleaf_pull',
      'overleaf_push',
      'overleaf_status',
    ])
  })

  it('declares parameters the installed dsh-tools accepts', async () => {
    const { tools } = await mount()
    for (const definition of tools.definitions) {
      // `defineTool` already compiled the author schema spec into the enforced
      // JSON Schema subset; re-asserting it here and validating values against
      // it is what fails when the harness dialect moves under the plugin.
      assertObjectJsonSchema(definition.parameters)
      expect(validateJsonSchemaValue(definition.parameters, {})).toEqual([])
      expect(validateJsonSchemaValue(definition.parameters, { mirrorPath: '/tmp/mirror' })).toEqual([])
      expect(validateJsonSchemaValue(definition.parameters, { mirrorPath: 42 })).not.toEqual([])
    }
  })

  it('renders the status summary from a resolved-remote result', async () => {
    const { tools } = await mount()
    const status = tools.definitions.find(definition => definition.name === 'overleaf_status')
    expect(status).toBeDefined()
    const value = {
      mirrorPath: '/tmp/mirror',
      summary: 'summary text',
      ahead: 2,
      behind: 1,
      dirty: false,
      diverged: true,
    }
    expect(status!.output.render({}, value)).toEqual([{ type: 'text', text: 'summary text' }])
  })
})
