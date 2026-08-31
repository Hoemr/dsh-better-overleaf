/**
 * Overleaf workbench tab container. Layout follows the user's priority: the
 * sync toolbar (pull/push/compile) sits on top, the auto-loaded project list
 * and bound-mirror list follow, and every configuration surface — login, git
 * token, auto-sync cadence — lives behind the settings modal. Remote status is
 * polled while the tab is visible and mirrored into a module store so the
 * tab-strip badge stays live.
 *
 * The host owns every credential and filesystem effect; this component only
 * renders wire-backed state. Files land in `<workspace>/overleaf/<name>/`, so
 * the sidebar's explorer, editor, viewers, and Git panel operate on them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { overleafApi } from './api.ts'
import { getActiveBetterSidebar } from './contract.ts'
import type { BetterSidebarRegistry, BetterSidebarTabProps } from './contract.ts'
import { BindingsList } from './components/BindingsList.tsx'
import { ProjectList } from './components/ProjectList.tsx'
import { SettingsModal } from './components/SettingsModal.tsx'
import type { LoginChannel } from './components/SettingsModal.tsx'
import { SyncToolbar } from './components/SyncToolbar.tsx'
import { BG, BORDER, LABEL_2, button, card, primary, relativeTime, row, SHEET } from './components/tokens.ts'
import { resetWorkspace, reportMirror } from './sync-store.ts'
import type { OverleafAutoSyncPolicy, OverleafBinding, OverleafLoginResult, OverleafProject, OverleafRemoteStatus, OverleafTransportKind } from '../types.ts'
import { DEFAULT_AUTO_SYNC_POLICY } from '../types.ts'

interface FsTreeEntry {
  name: string
  path: string
  isDir: boolean
  hidden?: boolean
}

/**
 * List one directory through better-sidebar's host API. The wire method name
 * is `fs.tree`; the envelope matches the shared `{ ok, value | error }` shape.
 */
async function listDirectory(sessionId: string, path: string): Promise<FsTreeEntry[]> {
  const response = await fetch('/sidebar/api/fs.tree', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, path }),
  })
  const envelope = await response.json() as
    | { ok: true; value: { entries: FsTreeEntry[] } }
    | { ok: false; error: { code: string; message: string } }
  if (!envelope.ok) throw new Error(envelope.error.message)
  return envelope.value.entries
}

/**
 * Read the head of one workspace file through better-sidebar's host API (used
 * to detect the LaTeX documentclass when choosing an entry file).
 */
async function readFileHead(sessionId: string, path: string): Promise<string> {
  const response = await fetch('/sidebar/api/fs.read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, path }),
  })
  const envelope = await response.json() as
    | { ok: true; value: { kind: string; content?: string; head?: string } }
    | { ok: false; error: { code: string; message: string } }
  if (!envelope.ok) throw new Error(envelope.error.message)
  return envelope.value.kind === 'text' ? envelope.value.content ?? '' : envelope.value.head ?? ''
}

/**
 * Pick the most entry-point-like file of a mirror, never a helper file:
 * `main.tex` first, then the `.tex` carrying a `\documentclass` (many Overleaf
 * projects name their root file after the paper), then any `.tex`, then a
 * `.pdf`; `undefined` means "open the folder in the explorer instead".
 */
async function pickEntryFile(sessionId: string, entries: FsTreeEntry[]): Promise<FsTreeEntry | undefined> {
  const files = entries.filter(entry => !entry.isDir && entry.hidden !== true)
  const main = files.find(file => file.name === 'main.tex')
  if (main !== undefined) return main
  const texFiles = files.filter(file => file.name.toLowerCase().endsWith('.tex'))
  for (const candidate of texFiles.slice(0, 6)) {
    try {
      const head = await readFileHead(sessionId, candidate.path)
      if (/\\documentclass\b/.test(head.slice(0, 4000))) return candidate
    } catch {
      // Unreadable candidate; keep scanning.
    }
  }
  return texFiles[0]
    ?? files.find(file => file.name.toLowerCase().endsWith('.pdf'))
}

/** Find the better-sidebar registry: module handle first, then scoped context. */
function resolveRegistry(ctx: unknown): BetterSidebarRegistry | undefined {
  const mounted = getActiveBetterSidebar()
  if (mounted !== undefined) return mounted
  if (typeof ctx !== 'object' || ctx === null) return undefined
  const candidate = ctx as { get?: (key: string) => unknown }
  for (const key of ['betterSidebar', 'better-sidebar', 'dsh-better-sidebar']) {
    const service = candidate.get?.(key)
    if (typeof service === 'object' && service !== null && 'registerTab' in service) {
      return service as BetterSidebarRegistry
    }
  }
  return undefined
}

/** Transient toast shown at the bottom of the tab. */
interface Toast {
  text: string
  kind: 'ok' | 'error'
}

const page: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px 14px',
  fontSize: 13, color: 'inherit', height: '100%', overflowY: 'auto', boxSizing: 'border-box',
  alignContent: 'start', position: 'relative',
}

/** The Overleaf workbench body registered as the better-sidebar tab component. */
export function OverleafManager({ scope, ctx, visible }: BetterSidebarTabProps): ReactElement {
  const [loggedIn, setLoggedIn] = useState(false)
  const [gitConfigured, setGitConfigured] = useState(false)
  const [projects, setProjects] = useState<OverleafProject[]>([])
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const [bindings, setBindings] = useState<OverleafBinding[]>([])
  const [statuses, setStatuses] = useState<Map<string, OverleafRemoteStatus>>(new Map())
  const [policy, setPolicyState] = useState<OverleafAutoSyncPolicy>(DEFAULT_AUTO_SYNC_POLICY)
  const [latexmkAvailable, setLatexmkAvailable] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [manualLogin, setManualLogin] = useState<OverleafLoginResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [workspacePath, setWorkspacePath] = useState(scope.cwd ?? '')

  const workspace = workspacePath.trim() === '' ? scope.cwd ?? '' : workspacePath.trim()
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  /** Flash a toast; errors stay longer. */
  const notify = useCallback((text: string, kind: 'ok' | 'error' = 'ok'): void => {
    setToast({ text, kind })
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => { setToast(null) }, kind === 'error' ? 9000 : 4500)
  }, [])

  /** Run one async action with the busy latch + toast reporting. */
  const run = useCallback(async (action: () => Promise<string>, onError?: () => void): Promise<void> => {
    setBusy(true)
    try {
      notify(await action())
    } catch (err) {
      onError?.()
      notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }, [notify])

  /** Refresh account state + workspace bindings. */
  const refreshBindings = useCallback(async (targetWorkspace: string): Promise<{ loggedIn: boolean; mirrors: OverleafBinding[] }> => {
    const status = await overleafApi.status(targetWorkspace === '' ? undefined : targetWorkspace)
    setLoggedIn(status.loggedIn)
    setGitConfigured(status.gitConfigured)
    setBindings(status.bindings ?? [])
    return { loggedIn: status.loggedIn, mirrors: status.bindings ?? [] }
  }, [])

  /** Re-check every mirror and rebuild the workspace badge aggregate. */
  const checkAll = useCallback(async (targetWorkspace: string, mirrorList: OverleafBinding[]): Promise<void> => {
    resetWorkspace(targetWorkspace)
    await Promise.all(mirrorList.map(async mirror => {
      const status = await overleafApi.remoteStatus(mirror.mirrorPath).catch(() => undefined)
      if (status !== undefined) {
        setStatuses(previous => new Map(previous).set(mirror.mirrorPath, status))
        reportMirror(targetWorkspace, { ahead: status.ahead, behind: status.behind, dirty: status.dirty })
      }
    }))
  }, [])

  /** Initial load: status → projects (auto) → latexmk probe → policy → statuses. */
  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const { loggedIn: accountReady, mirrors } = await refreshBindings(workspace)
        if (cancelled) return
        if (mirrors.length > 0) {
          setSelectedPath(current => current ?? mirrors[0]?.mirrorPath)
          void checkAll(workspace, mirrors)
        }
        if (accountReady) {
          const list = await overleafApi.projects()
          if (!cancelled) { setProjects(list); setProjectsLoaded(true) }
        } else if (!cancelled) {
          setProjectsLoaded(true)
        }
      } catch (err) {
        if (!cancelled) setProjectsLoaded(true)
        notify(err instanceof Error ? err.message : String(err), 'error')
      }
      void overleafApi.latexmk().then(available => { if (!cancelled) setLatexmkAvailable(available) }).catch(() => undefined)
      void overleafApi.autoSync().then(loaded => { if (!cancelled) setPolicyState(loaded) }).catch(() => undefined)
    })()
    return () => { cancelled = true }
    // The workspace is intentionally read only on mount; rebinds refresh explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Poll statuses while the tab is visible. */
  useEffect(() => {
    if (!visible || bindings.length === 0) return
    const timer = setInterval(() => { void checkAll(workspace, bindings) }, 90_000)
    return () => { clearInterval(timer) }
  }, [visible, bindings, workspace, checkAll])

  /**
   * Land the user inside one mirror: open its entry file (main.tex, or the
   * .tex carrying a documentclass, or the PDF), else fall back to the explorer.
   */
  const openMirrorInSidebar = useCallback(async (mirrorPath: string): Promise<void> => {
    const registry = resolveRegistry(ctx)
    if (registry === undefined) return
    try {
      const entries = await listDirectory(scope.sessionId, mirrorPath)
      const entryFile = await pickEntryFile(scope.sessionId, entries)
      if (entryFile !== undefined && registry.openFile !== undefined) {
        registry.openFile(scope, entryFile.path, entryFile.name)
        return
      }
    } catch {
      // Directory unreadable or empty; fall through to the explorer.
    }
    registry.openTab?.({ type: 'explorer' }, scope)
  }, [ctx, scope])

  const selectedMirror = useMemo(
    () => bindings.find(mirror => mirror.mirrorPath === selectedPath) ?? bindings[0],
    [bindings, selectedPath],
  )
  const selectedStatus = selectedMirror === undefined ? undefined : statuses.get(selectedMirror.mirrorPath)

  const boundIds = useMemo(() => new Set(bindings.map(mirror => mirror.projectId)), [bindings])

  const afterBindingChange = useCallback(async (): Promise<void> => {
    const { mirrors: mirrorList } = await refreshBindings(workspace)
    setSelectedPath(current => current ?? mirrorList[0]?.mirrorPath)
    await checkAll(workspace, mirrorList)
  }, [refreshBindings, checkAll, workspace])

  const login = (channel: LoginChannel, customPath: string): void => {
    void run(async () => {
      const result = await overleafApi.login(channel === 'custom' ? undefined : channel, channel === 'custom' ? customPath : undefined)
      if (result.kind === 'manual') {
        setManualLogin(result)
        return '已打开浏览器；登录后按提示粘贴 cookie'
      }
      setManualLogin(null)
      await refreshBindings(workspace)
      const list = await overleafApi.projects()
      setProjects(list)
      setProjectsLoaded(true)
      return 'Overleaf 登录成功'
    })
  }

  const saveCookie = (cookie: string): void => {
    void run(async () => {
      await overleafApi.saveCookie(cookie)
      setManualLogin(null)
      await refreshBindings(workspace)
      return 'Overleaf cookie 已保存'
    })
  }

  const saveGitToken = (token: string): void => {
    void run(async () => {
      await overleafApi.saveGitToken(token)
      await refreshBindings(workspace)
      return '同步令牌已保存，Git 双向同步已启用'
    })
  }

  const setPolicy = (next: OverleafAutoSyncPolicy): void => {
    setPolicyState(next)
    void overleafApi.setAutoSync(next).then(applied => { setPolicyState(applied) })
      .catch((err: unknown) => { notify(err instanceof Error ? err.message : String(err), 'error') })
  }

  const loadProjects = (): void => {
    void run(async () => {
      const list = await overleafApi.projects()
      setProjects(list)
      setProjectsLoaded(true)
      return `已加载 ${String(list.length)} 个项目`
    })
  }

  const bind = (project: OverleafProject, name: string, transport: OverleafTransportKind | 'auto'): void => {
    void run(async () => {
      const binding = await overleafApi.bind(workspace, project.id, transport, name)
      await afterBindingChange()
      void openMirrorInSidebar(binding.mirrorPath)
      return `已绑定「${binding.projectName}」并拉取到 ${binding.mirrorPath}`
    })
  }

  const syncMirror = (mirror: OverleafBinding, direction: 'pull' | 'push'): void => {
    void run(async () => {
      const result = await overleafApi.sync(mirror.mirrorPath, direction)
      await overleafApi.remoteStatus(mirror.mirrorPath).then(status => {
        setStatuses(previous => new Map(previous).set(mirror.mirrorPath, status))
      }).catch(() => undefined)
      await checkAll(workspace, bindings)
      // Ask the Files tree to re-read from disk. The convention lives upstream
      // (dsh-better-sidebar PR #469); dispatching is a no-op on builds without it.
      globalThis.dispatchEvent(new Event('dsh-sidebar:refresh-files'))
      return `${mirror.projectName}：${result.message}`
    })
  }

  /** Switch a snapshot-only mirror to two-way git sync. */
  const upgradeMirror = (mirror: OverleafBinding): void => {
    void run(async () => {
      const result = await overleafApi.upgradeTransport(mirror.mirrorPath)
      await afterBindingChange()
      void openMirrorInSidebar(mirror.mirrorPath)
      return `${mirror.projectName}：${result.message}`
    })
  }

  const checkSelected = (): void => {
    if (selectedMirror === undefined) return
    void run(async () => {
      await checkAll(workspace, bindings)
      const status = statuses.get(selectedMirror.mirrorPath)
      if (status !== undefined && status.remoteAvailable) {
        return `${selectedMirror.projectName}：落后 ${String(status.behind)} 个提交、领先 ${String(status.ahead)} 个提交${status.remoteCommitTime !== undefined ? `，远端更新于 ${relativeTime(status.remoteCommitTime)}` : ''}`
      }
      return '已重新检查远端状态'
    })
  }

  const compileMirror = (mirror: OverleafBinding): void => {
    void run(async () => {
      const result = await overleafApi.compile(mirror.mirrorPath)
      if (result.ok && result.pdfPath !== undefined) {
        const registry = resolveRegistry(ctx)
        registry?.openFile?.(scope, result.pdfPath, `${mirror.projectName}.pdf`)
        return `编译成功（${String(Math.round(result.durationMs / 100) / 10)}s），已打开 ${result.entryFile.replace(/\.tex$/i, '.pdf')}`
      }
      const tail = result.logTail.split('\n').filter(line => line.trim() !== '').slice(-6).join('\n')
      throw new Error(`编译失败（入口 ${result.entryFile}）：\n${tail}`)
    })
  }

  const unbindMirror = (mirror: OverleafBinding): void => {
    void run(async () => {
      await overleafApi.unbind(mirror.mirrorPath)
      setStatuses(previous => {
        const next = new Map(previous)
        next.delete(mirror.mirrorPath)
        return next
      })
      await afterBindingChange()
      return `已解绑 ${mirror.projectName}（本地文件保留）`
    })
  }

  return (
    <div style={page} className="dov-page">
      <style>{SHEET}</style>

      {toast !== null && (
        <div
          role={toast.kind === 'error' ? 'alert' : 'status'}
          style={{
            position: 'sticky', bottom: 0, zIndex: 50,
            margin: '0 -12px -14px', padding: '9px 14px',
            background: toast.kind === 'error'
              ? 'rgba(210,79,79,0.14)'
              : 'rgba(31,138,91,0.14)',
            borderTop: `1px solid ${BORDER}`,
            fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            backdropFilter: 'blur(4px)',
          }}
        >
          {toast.text}
        </div>
      )}

      {settingsOpen && (
        <SettingsModal
          loggedIn={loggedIn}
          gitConfigured={gitConfigured}
          busy={busy}
          policy={policy}
          manualLogin={manualLogin}
          latexmkAvailable={latexmkAvailable}
          onClose={() => { setSettingsOpen(false) }}
          onLogin={login}
          onSaveCookie={saveCookie}
          onSaveGitToken={saveGitToken}
          onPolicyChange={setPolicy}
        />
      )}

      {!loggedIn && (
        <section style={{ ...card, alignItems: 'flex-start', gap: 10 }}>
          <strong style={{ fontSize: 14 }}>连接 Overleaf</strong>
          <span style={{ color: LABEL_2, fontSize: 12, lineHeight: 1.6 }}>
            登录后即可把 Overleaf 项目同步到本地，在 DSH 里直接用 AI 修改、编译、再推送回 Overleaf。
          </span>
          <button
            onClick={() => { setSettingsOpen(true) }}
            disabled={busy}
            style={{ ...button, ...primary }}
            className="dov-btn dov-btn-primary"
          >
            前往登录 →
          </button>
        </section>
      )}

      {loggedIn && selectedMirror !== undefined && (
        <SyncToolbar
          mirror={selectedMirror}
          status={selectedStatus}
          busy={busy}
          latexmkAvailable={latexmkAvailable}
          onPull={() => { syncMirror(selectedMirror, 'pull') }}
          onPush={() => { syncMirror(selectedMirror, 'push') }}
          onCheck={checkSelected}
          onCompile={() => { compileMirror(selectedMirror) }}
          onOpenSettings={() => { setSettingsOpen(true) }}
          onOpenMirror={() => { void openMirrorInSidebar(selectedMirror.mirrorPath) }}
        />
      )}

      {loggedIn && (
        <ProjectList
          projects={projects}
          loaded={projectsLoaded}
          boundIds={boundIds}
          busy={busy}
          error={undefined}
          onBind={bind}
          onReload={loadProjects}
        />
      )}

      {selectedMirror !== undefined && (
        <label style={{ ...row, gap: 6, fontSize: 12, color: LABEL_2 }}>
          工作区
          <input
            value={workspacePath}
            onChange={event => { setWorkspacePath(event.target.value) }}
            placeholder={scope.cwd ?? 'D:/path/to/workspace'}
            disabled={busy}
            style={{
              padding: '4px 8px', borderRadius: 6, border: `1px solid ${BORDER}`,
              background: BG, color: 'inherit', fontSize: 12, outline: 'none', flex: 1, minWidth: 160,
              boxSizing: 'border-box',
            }}
            className="dov-input"
            spellCheck={false}
          />
        </label>
      )}

      <BindingsList
        bindings={bindings}
        statuses={statuses}
        selectedPath={selectedMirror?.mirrorPath}
        busy={busy}
        onSelect={setSelectedPath}
        onPull={mirror => { syncMirror(mirror, 'pull') }}
        onPush={mirror => { syncMirror(mirror, 'push') }}
        onOpen={mirror => { void openMirrorInSidebar(mirror.mirrorPath) }}
        onUpgrade={upgradeMirror}
        onUnbind={unbindMirror}
      />

      {loggedIn && selectedMirror === undefined && projectsLoaded && (
        <div style={{ color: LABEL_2, fontSize: 12, textAlign: 'center', padding: '6px 0' }}>
          在上方选择一个项目，点击即可绑定到当前工作区
        </div>
      )}
    </div>
  )
}
