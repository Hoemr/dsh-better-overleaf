/**
 * Ambient types for `@deepseek-ai/dsh-tools`, resolved at runtime from the DSH
 * host installation (linked in devDependencies — the package ships inside the
 * desktop app and is not on npm). Only the surface dsh-better-overleaf uses is
 * declared; the runtime validates schemas itself, so these types stay loose on
 * purpose.
 */
declare module '@deepseek-ai/dsh-tools' {
  /** One parameter field of a tool's input schema (host schema-spec dialect). */
  export interface ToolParamSpec {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object'
    description?: string
    required?: boolean
    /** Enumerated values for string params. */
    enum?: readonly string[]
    items?: ToolParamSpec
    properties?: Record<string, ToolParamSpec>
    additionalProperties?: boolean
  }

  /** One field of a tool's structured output schema. */
  export interface ToolOutputFieldSpec {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object'
    description?: string
    required?: boolean
    items?: ToolOutputFieldSpec
    properties?: Record<string, ToolOutputFieldSpec>
    additionalProperties?: boolean
  }

  /** Execution context handed to a tool's `execute`. */
  export interface ToolExecContext {
    signal: AbortSignal
    agent?: { session?: { id?: string; header?: { cwd?: string } } }
  }

  /** The options `defineTool` accepts (the subset this plugin uses). */
  export interface ToolDefinition<A extends Record<string, unknown> = Record<string, unknown>, R extends object = Record<string, unknown>> {
    name: string
    description: string
    parameters: Record<string, ToolParamSpec>
    output: {
      schema: {
        type: 'object'
        additionalProperties: false
        properties: Record<string, ToolOutputFieldSpec>
      }
      render: (args: A, value: R) => Array<{ type: 'text'; text: string }>
    }
    execute: (args: A, exec: ToolExecContext) => Promise<R>
    timeoutMs?: number
    isConcurrencySafe?: (args: A) => boolean
  }

  /** The registered tool object (opaque to callers; the runtime consumes it). */
  export interface RegisteredTool {
    name: string
    description: string
  }

  /** Validate + normalize one tool definition into the runtime's shape. */
  export function defineTool<A extends Record<string, unknown> = Record<string, unknown>, R extends object = Record<string, unknown>>(
    options: ToolDefinition<A, R>,
  ): RegisteredTool
}

/** Bundler raw-text import (`?raw`) for inlining the pdf.js worker source. */
declare module '*?raw' {
  const content: string
  export default content
}
