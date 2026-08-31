/**
 * Agent-facing Overleaf tools. Registered lazily through `ctx.inject(['tools'])`
 * so a tools-less host still mounts the core plugin. Tools resolve the calling
 * session's workspace from the session store, then reuse the same service
 * operations the tab exposes — the model can pull, push, and compile the way
 * the user does, which is what makes an "edit → compile → sync" loop work
 * inside one conversation.
 * @module dsh-better-overleaf/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { listWorkspaceBindings } from './paths.ts'
import type { OverleafService } from './service.ts'

/** One tool result rendered as plain model-facing text. */
function textRender<R>(fn: (value: R) => string): (_args: unknown, value: R) => Array<{ type: 'text'; text: string }> {
  return (_args, value) => [{ type: 'text', text: fn(value) }]
}

/** Calling-session id, or undefined outside an agent loop. */
function sessionIdOf(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { session?: { id?: unknown } } }).agent
  const id = agent?.session?.id
  return typeof id === 'string' ? id : undefined
}

/** Tool surface the service exposes; mirrors OverleafService methods. */
export interface OverleafToolFacade {
  remoteStatus(mirrorPath: string): Promise<{ ahead: number; behind: number; dirty: boolean; diverged: boolean; remoteAvailable: boolean; remoteCommitTime?: string }>
  sync(mirrorPath: string, direction: 'pull' | 'push'): Promise<{ message: string; conflictFiles?: string[] }>
  compile(mirrorPath: string): Promise<{ ok: boolean; pdfPath?: string; entryFile: string; logTail: string }>
  latexmkAvailable(): Promise<boolean>
}

/** Shared arg/error plumbing for one tool execution. */
interface ToolExec {
  signal: AbortSignal
  agent?: { session?: { id?: unknown } }
}

/**
 * Register the four Overleaf tools once the host tool registry appears.
 * @param ctx - host plugin context.
 * @param service - the mounted Overleaf service (operations + config).
 * @returns nothing; registration is fire-and-forget via the inject waiter.
 */
export function registerOverleafTools(ctx: Context, service: OverleafService): void {
  const register = (toolsCtx: Context): void => {
    const tools = (toolsCtx as Context & { tools?: { register: (tool: unknown) => () => void } }).tools
    if (tools === undefined) return

    /** Resolve the calling session's workspace (falls back to the host cwd). */
    const workspaceOf = (exec: ToolExec): string | undefined => {
      const sessionId = sessionIdOf(exec)
      if (sessionId === undefined) return undefined
      const headerCwd = (ctx as Context & { sessions?: { get: (id: string) => { header: { cwd?: string } } | undefined } })
        .sessions?.get(sessionId)?.header.cwd
      return headerCwd !== undefined && headerCwd !== '' ? headerCwd : undefined
    }

    /** Resolve the target mirror: explicit arg, the session workspace's only mirror, or a clear error. */
    const resolveMirror = async (exec: ToolExec, mirrorPath: string | undefined): Promise<{ mirrorPath: string; workspacePath?: string }> => {
      if (mirrorPath !== undefined && mirrorPath.trim() !== '') {
        return { mirrorPath: mirrorPath.trim() }
      }
      const workspacePath = workspaceOf(exec)
      if (workspacePath === undefined) {
        throw new Error('overleaf: 当前会话没有工作目录，请传入 mirrorPath 指定要操作的镜像目录')
      }
      const bindings = await listWorkspaceBindings(workspacePath)
      if (bindings.length === 0) {
        throw new Error(`overleaf: 工作区 ${workspacePath} 下没有已绑定的 Overleaf 镜像（overleaf/ 目录为空）`)
      }
      if (bindings.length > 1) {
        const list = bindings.map(binding => `${binding.projectName} → ${binding.mirrorPath}`).join('；')
        throw new Error(`overleaf: 工作区绑定了多个项目，请指定 mirrorPath。可用镜像：${list}`)
      }
      return { mirrorPath: bindings[0]!.mirrorPath, workspacePath }
    }

    tools.register(defineTool({
      name: 'overleaf_status',
      description: '查看 Overleaf 镜像与远端的同步状态：领先/落后多少提交、工作区是否有未提交修改、远端最后一次提交时间。默认作用于当前会话工作区唯一的绑定项目；工作区绑定了多个项目时必须传 mirrorPath。',
      parameters: {
        mirrorPath: { type: 'string', description: '镜像目录绝对路径（缺省时自动解析为当前会话工作区唯一的绑定镜像）。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mirrorPath: { type: 'string', required: true, description: '镜像目录。' },
            summary: { type: 'string', required: true, description: '人类可读的状态摘要。' },
            ahead: { type: 'number', required: true, description: '本地领先远端的提交数。' },
            behind: { type: 'number', required: true, description: '远端领先本地的提交数（待拉取）。' },
            dirty: { type: 'boolean', required: true, description: '工作区是否有未提交修改。' },
            diverged: { type: 'boolean', required: true, description: '本地与远端是否已分叉。' },
          },
        },
        render: textRender((value: { summary: string }) => value.summary),
      },
      execute: async (args: { mirrorPath?: string }, exec: ToolExec) => {
        exec.signal.throwIfAborted()
        const { mirrorPath } = await resolveMirror(exec, args.mirrorPath)
        const status = await service.remoteStatus(mirrorPath)
        const summary = status.remoteAvailable === false
          ? `${mirrorPath}：网页快照模式（无 git 远端），仅支持单向拉取${status.dirty ? `；工作区有 ${String((status as { dirtyCount?: number }).dirtyCount ?? 0)} 个未提交文件` : ''}`
          : `${mirrorPath}：本地领先 ${String(status.ahead)} 个提交、落后 ${String(status.behind)} 个提交，${status.dirty ? '工作区有未提交修改' : '工作区干净'}，${status.diverged ? '已分叉（拉取时将自动变基）' : '未分叉'}${status.remoteCommitTime !== undefined ? `，远端最后提交于 ${status.remoteCommitTime}` : ''}`
        return { mirrorPath, summary, ahead: status.ahead, behind: status.behind, dirty: status.dirty, diverged: status.diverged }
      },
    }))

    tools.register(defineTool({
      name: 'overleaf_pull',
      description: '从 Overleaf 拉取一个镜像的最新内容。本地未提交的修改会先自动提交，然后用变基（rebase）方式合并远端提交；遇到冲突时会中止并报告冲突文件。默认作用于当前会话工作区唯一的绑定项目。',
      parameters: {
        mirrorPath: { type: 'string', description: '镜像目录绝对路径（缺省时自动解析）。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mirrorPath: { type: 'string', required: true, description: '镜像目录。' },
            message: { type: 'string', required: true, description: '同步结果摘要。' },
            conflictFiles: { type: 'array', description: '拉取发生冲突时的冲突文件列表。', items: { type: 'string' } },
          },
        },
        render: textRender((value: { message: string; conflictFiles?: string[] }) =>
          value.conflictFiles !== undefined
            ? `${value.message}（冲突文件：${value.conflictFiles.join('、')}）`
            : value.message),
      },
      execute: async (args: { mirrorPath?: string }, exec: ToolExec) => {
        exec.signal.throwIfAborted()
        const { mirrorPath } = await resolveMirror(exec, args.mirrorPath)
        const result = await service.sync(mirrorPath, 'pull')
        return { mirrorPath, message: result.message, ...(result.conflictFiles !== undefined ? { conflictFiles: result.conflictFiles } : {}) }
      },
    }))

    tools.register(defineTool({
      name: 'overleaf_push',
      description: '把一个镜像的本地修改推送到 Overleaf：先自动提交全部修改，再推送。若远端有更新的提交会拒绝并提示先拉取。默认作用于当前会话工作区唯一的绑定项目。',
      parameters: {
        mirrorPath: { type: 'string', description: '镜像目录绝对路径（缺省时自动解析）。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mirrorPath: { type: 'string', required: true, description: '镜像目录。' },
            message: { type: 'string', required: true, description: '推送结果摘要。' },
          },
        },
        render: textRender((value: { message: string }) => value.message),
      },
      execute: async (args: { mirrorPath?: string }, exec: ToolExec) => {
        exec.signal.throwIfAborted()
        const { mirrorPath } = await resolveMirror(exec, args.mirrorPath)
        const result = await service.sync(mirrorPath, 'push')
        return { mirrorPath, message: result.message }
      },
    }))

    tools.register(defineTool({
      name: 'overleaf_compile',
      description: '在本地用 latexmk 编译一个 Overleaf 镜像的 LaTeX 项目并生成 PDF（需要本机安装 TeX Live 或 MiKTeX）。适合修改 .tex 后立即检查编译结果；返回的 pdfPath 可交给侧边栏 PDF 预览打开。',
      parameters: {
        mirrorPath: { type: 'string', description: '镜像目录绝对路径（缺省时自动解析）。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mirrorPath: { type: 'string', required: true, description: '镜像目录。' },
            ok: { type: 'boolean', required: true, description: '编译是否成功。' },
            pdfPath: { type: 'string', description: '生成的 PDF 绝对路径（成功时）。' },
            entryFile: { type: 'string', required: true, description: '编译的入口 .tex。' },
            logTail: { type: 'string', required: true, description: '编译日志尾部（失败时的错误就在这里）。' },
          },
        },
        render: textRender((value: { ok: boolean; pdfPath?: string; entryFile: string; logTail: string }) =>
          value.ok
            ? `编译成功：${String(value.pdfPath)}（入口 ${value.entryFile}）`
            : `编译失败（入口 ${value.entryFile}），日志尾部：\n${value.logTail}`),
      },
      execute: async (args: { mirrorPath?: string }, exec: ToolExec) => {
        exec.signal.throwIfAborted()
        const { mirrorPath } = await resolveMirror(exec, args.mirrorPath)
        const result = await service.compile(mirrorPath)
        return {
          mirrorPath,
          ok: result.ok,
          ...(result.pdfPath !== undefined ? { pdfPath: result.pdfPath } : {}),
          entryFile: result.entryFile,
          logTail: result.logTail,
        }
      },
    }))
  }
  ctx.inject(['tools'] as unknown as Array<keyof Context>, register)
}
