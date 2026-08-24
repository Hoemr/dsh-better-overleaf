/**
 * Overleaf project manager tab for dsh-better-sidebar. The host owns every
 * credential and filesystem effect; this component renders wire-backed forms:
 * account login, searchable project list, mirror binding into the session
 * workspace, and pull/push per mirror. Files land in
 * `<workspace>/overleaf/<name>/`, so the sidebar's explorer, editor,
 * previewers, and Git panel operate on them directly.
 *
 * Styling consumes the DSH design tokens (`--dsw-alias-*`, `--dsh-scrollbar-*`)
 * with literal fallbacks, so light/dark themes follow the host automatically;
 * one injected `<style>` block (`dov-` prefix) adds the states inline styles
 * cannot express (hover, focus, native option colors, scrollbars).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { overleafApi } from './api.ts'
import { BindIcon, LoginIcon, ProjectsIcon, SyncIcon } from './icons.tsx'
import { getActiveBetterSidebar } from './contract.ts'
import type { BetterSidebarRegistry, BetterSidebarTabProps } from './contract.ts'
import type { OverleafBinding, OverleafLoginResult, OverleafProject, OverleafTransportKind } from '../types.ts'

type Channel = 'auto' | 'default' | 'msedge' | 'chrome' | 'custom' | 'real'

const ACCENT = 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, #1f8a5b)'
const ACCENT_CONTRAST = 'var(--dsw-alias-label-primary-foreground, #fff)'
const BG_LAYER = 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05))'
const BG_HOVER = 'var(--dsw-alias-bg-skeleton, rgba(127,127,127,0.09))'
const BORDER = 'var(--dsw-alias-border-l2, rgba(127,127,127,0.22))'
const LABEL_2 = 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.85))'
const LABEL_3 = 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.6))'

const S = {
  page: {
    display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px 14px',
    fontSize: 13, color: 'inherit', height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    alignContent: 'start',
  } satisfies CSSProperties,
  card: {
    display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px',
    border: `1px solid ${BORDER}`, borderRadius: 10,
    background: BG_LAYER, flexShrink: 0,
  } satisfies CSSProperties,
  title: { display: 'flex', alignItems: 'center', gap: 7, margin: 0, fontSize: 13, fontWeight: 600 } satisfies CSSProperties,
  methodTitle: { fontSize: 12, fontWeight: 600, color: LABEL_2 } satisfies CSSProperties,
  bullets: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 } satisfies CSSProperties,
  hint: { margin: 0, lineHeight: 1.45, fontSize: 12, color: LABEL_2 } satisfies CSSProperties,
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } satisfies CSSProperties,
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180, flex: 1 } satisfies CSSProperties,
  label: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: LABEL_2 } satisfies CSSProperties,
  input: {
    padding: '6px 9px', borderRadius: 7, border: `1px solid ${BORDER}`,
    background: 'transparent', color: 'inherit', fontSize: 13, outline: 'none', width: '100%',
    boxSizing: 'border-box',
  } satisfies CSSProperties,
  select: {
    padding: '6px 8px', borderRadius: 7, border: `1px solid ${BORDER}`,
    background: 'transparent', color: 'inherit', fontSize: 13, outline: 'none', width: '100%',
    boxSizing: 'border-box',
  } satisfies CSSProperties,
  textarea: {
    padding: '8px 9px', borderRadius: 8, border: `1px solid ${BORDER}`,
    background: 'transparent', color: 'inherit', fontSize: 12, outline: 'none',
    resize: 'vertical', minHeight: 60, width: '100%', boxSizing: 'border-box',
  } satisfies CSSProperties,
  button: {
    padding: '6px 12px', borderRadius: 7, border: `1px solid ${BORDER}`,
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13,
    transition: 'background 120ms ease, border-color 120ms ease',
  } satisfies CSSProperties,
  primary: { background: ACCENT, borderColor: ACCENT, color: ACCENT_CONTRAST } satisfies CSSProperties,
  danger: { color: '#e06c6c' } satisfies CSSProperties,
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px',
    borderRadius: 999, fontSize: 12, border: `1px solid ${BORDER}`,
  } satisfies CSSProperties,
  chipOk: { background: 'rgba(31,138,91,0.15)' } satisfies CSSProperties,
  chipBad: { background: 'rgba(220,72,72,0.13)' } satisfies CSSProperties,
  toolbar: {
    display: 'flex', gap: 8, alignItems: 'center',
  } satisfies CSSProperties,
  searchBox: { position: 'relative', flex: 1, minWidth: 160 } satisfies CSSProperties,
  searchInput: {
    padding: '6px 26px 6px 28px', borderRadius: 7, border: `1px solid ${BORDER}`,
    background: 'transparent', color: 'inherit', fontSize: 13, outline: 'none', width: '100%',
    boxSizing: 'border-box',
  } satisfies CSSProperties,
  searchIcon: {
    position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)',
    opacity: 0.45, fontSize: 12, pointerEvents: 'none',
  } satisfies CSSProperties,
  clearBtn: {
    position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)',
    border: 'none', background: 'transparent', color: 'inherit', opacity: 0.5,
    cursor: 'pointer', fontSize: 13, padding: '2px 6px', borderRadius: 6,
  } satisfies CSSProperties,
  count: { fontSize: 12, color: LABEL_3, whiteSpace: 'nowrap' } satisfies CSSProperties,
  list: {
    display: 'flex', flexDirection: 'column', gap: 3,
    maxHeight: 320, overflowY: 'auto', paddingRight: 2, marginTop: 2,
  } satisfies CSSProperties,
  projectRow: {
    display: 'flex', alignItems: 'center', width: '100%',
    padding: '7px 10px', borderRadius: 7, border: '1px solid transparent',
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13, textAlign: 'left',
    transition: 'background 100ms ease',
  } satisfies CSSProperties,
  mirrorRow: {
    display: 'flex', flexDirection: 'column', gap: 6, padding: '9px 11px',
    borderRadius: 8, border: `1px solid ${BORDER}`,
  } satisfies CSSProperties,
  meta: { fontSize: 11, color: LABEL_3, wordBreak: 'break-all' } as CSSProperties,
  status: { padding: '8px 11px', borderRadius: 8, background: 'rgba(31,138,91,0.13)', fontSize: 12 } satisfies CSSProperties,
  error: {
    padding: '8px 11px', borderRadius: 8, background: 'rgba(220,72,72,0.15)',
    fontSize: 12, wordBreak: 'break-all',
  } satisfies CSSProperties,
  manual: { display: 'flex', flexDirection: 'column', gap: 7, padding: 10, borderRadius: 8, background: 'var(--dsw-alias-bg-skeleton, rgba(219,168,50,0.10))' } satisfies CSSProperties,
  empty: { opacity: 0.5, fontSize: 12, textAlign: 'center', padding: '14px 0' } satisfies CSSProperties,
}

/** Theme-following states inline styles cannot express. */
const STYLE_SHEET = `
.dov-select option {
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #222);
}
.dov-btn:hover { background: ${BG_HOVER} !important; }
.dov-btn-primary:hover { filter: brightness(1.12) !important; }
.dov-clear:hover { opacity: 1 !important; background: ${BG_HOVER} !important; }
.dov-input:focus, .dov-select:focus { border-color: ${ACCENT} !important; }
.dov-project { outline: none; }
.dov-project:hover { background: var(--dsw-alias-bg-skeleton, rgba(127,127,127,0.08)) !important; }
.dov-project:focus-visible { outline: 1px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.4)); outline-offset: -1px; }
.dov-project.dov-selected { border-color: ${ACCENT} !important; background: var(--dsw-alias-bg-multi-select, rgba(31,138,91,0.10)) !important; }
.dov-project .dov-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.dov-project .dov-date { flex: none; margin-left: 8px; font-size: 11px; color: ${LABEL_3}; }
.dov-list::-webkit-scrollbar, .dov-page::-webkit-scrollbar { width: 8px; height: 8px; }
.dov-list::-webkit-scrollbar-thumb, .dov-page::-webkit-scrollbar-thumb {
  background: var(--dsh-scrollbar-thumb, rgba(127,127,127,0.30)); border-radius: 4px;
}
.dov-list::-webkit-scrollbar-thumb:hover, .dov-page::-webkit-scrollbar-thumb:hover {
  background: var(--dsh-scrollbar-thumb-hover, rgba(127,127,127,0.45));
}
.dov-list::-webkit-scrollbar-track, .dov-page::-webkit-scrollbar-track { background: transparent; }
`

const CHANNEL_KEY = 'dsh-overleaf:browser-channel'
const PATH_KEY = 'dsh-overleaf:browser-path'

function readStored(key: string, fallback: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function storeValue(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // Privacy-blocked storage keeps the in-memory choice only.
  }
}

/** Normalize a stored channel value to the supported set. */
function readChannelChoice(): Channel {
  const stored = readStored(CHANNEL_KEY, 'auto')
  return stored === 'auto' || stored === 'default' || stored === 'msedge' || stored === 'chrome' || stored === 'custom' || stored === 'real'
    ? stored
    : 'auto'
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
 * Pick the most entry-point-like file of a mirror: main.tex first, then any
 * other .tex, then the first visible file.
 */
function pickEntryFile(entries: FsTreeEntry[]): FsTreeEntry | undefined {
  const files = entries.filter(entry => !entry.isDir && entry.hidden !== true)
  return files.find(file => file.name === 'main.tex')
    ?? files.find(file => file.name.toLowerCase().endsWith('.tex'))
    ?? files[0]
}

/**
 * The Overleaf workbench body registered as the better-sidebar tab component.
 */
export function OverleafManager({ scope, ctx }: BetterSidebarTabProps): ReactElement {
  const [channel, setChannel] = useState<Channel>(readChannelChoice)
  const [customPath, setCustomPath] = useState(() => readStored(PATH_KEY, ''))
  const [manualLogin, setManualLogin] = useState<OverleafLoginResult | null>(null)
  const [cookieDraft, setCookieDraft] = useState('')
  const [gitTokenDraft, setGitTokenDraft] = useState('')
  const [gitTokenOpen, setGitTokenOpen] = useState(false)
  const [manualProjectId, setManualProjectId] = useState('')
  const [loggedIn, setLoggedIn] = useState(false)
  const [gitConfigured, setGitConfigured] = useState(false)
  const [projects, setProjects] = useState<OverleafProject[]>([])
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const [projectFilter, setProjectFilter] = useState('')
  const [selectedProject, setSelectedProject] = useState<OverleafProject | null>(null)
  const [bindings, setBindings] = useState<OverleafBinding[]>([])
  const [lastMirrorPath, setLastMirrorPath] = useState<string | undefined>(undefined)
  const [workspacePath, setWorkspacePath] = useState(scope.cwd ?? '')
  const [mirrorName, setMirrorName] = useState('')
  const [transport, setTransport] = useState<OverleafTransportKind | 'auto'>('auto')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const workspace = workspacePath.trim()

  const run = useCallback(async (action: () => Promise<string>): Promise<void> => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      setMessage(await action())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const refresh = useCallback(async (targetWorkspace: string): Promise<void> => {
    const status = await overleafApi.status(targetWorkspace === '' ? undefined : targetWorkspace)
    setLoggedIn(status.loggedIn)
    setGitConfigured(status.gitConfigured)
    setBindings(status.bindings ?? [])
  }, [])

  useEffect(() => {
    void refresh(workspace).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    })
    // The workspace path is intentionally read only on mount; rebinds refresh explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chooseChannel = (value: Channel): void => {
    setChannel(value)
    storeValue(CHANNEL_KEY, value)
  }

  const chooseCustomPath = (value: string): void => {
    setCustomPath(value)
    storeValue(PATH_KEY, value)
  }

  const login = (): void => {
    void run(async () => {
      const result = await overleafApi.login(channel === 'custom' ? undefined : channel, channel === 'custom' ? customPath : undefined)
      if (result.kind === 'manual') {
        setManualLogin(result)
        return '已打开浏览器；登录后按提示粘贴 cookie'
      }
      setManualLogin(null)
      await refresh(workspace)
      return 'Overleaf cookie 已保存'
    })
  }

  const saveCookie = (): void => {
    void run(async () => {
      await overleafApi.saveCookie(cookieDraft)
      setManualLogin(null)
      setCookieDraft('')
      await refresh(workspace)
      return 'Overleaf cookie 已保存'
    })
  }

  const saveGitToken = (): void => {
    void run(async () => {
      await overleafApi.saveGitToken(gitTokenDraft)
      setGitTokenDraft('')
      setGitTokenOpen(false)
      await refresh(workspace)
      return '同步令牌已保存，Git 双向同步已启用'
    })
  }

  const loadProjects = (): void => {
    void run(async () => {
      const list = await overleafApi.projects()
      setProjects(list)
      setProjectsLoaded(true)
      return `已加载 ${String(list.length)} 个项目`
    })
  }

  const effectiveProjectId = selectedProject?.id ?? manualProjectId.trim()
  const bind = (): void => {
    if (effectiveProjectId === '') return
    void run(async () => {
      const binding = await overleafApi.bind(workspace, effectiveProjectId, transport, selectedProject?.name ?? mirrorName)
      setSelectedProject(null)
      setManualProjectId('')
      setMirrorName('')
      await refresh(workspace)
      setLastMirrorPath(binding.mirrorPath)
      void openMirrorInSidebar(binding.mirrorPath)
      return `已绑定并拉取到 ${binding.mirrorPath}`
    })
  }

  /**
   * Land the user inside one mirror: pick its entry file (main.tex first) and
   * open it through better-sidebar's content-level openFile, which also
   * expands the hosting panel — a bare openTab('explorer') would not.
   * Falls back to focusing the explorer when nothing readable is found.
   */
  const openMirrorInSidebar = async (mirrorPath: string): Promise<void> => {
    const registry = resolveRegistry(ctx)
    if (registry === undefined) return
    try {
      const entries = await listDirectory(scope.sessionId, mirrorPath)
      const entryFile = pickEntryFile(entries)
      if (entryFile !== undefined && registry.openFile !== undefined) {
        registry.openFile(scope, entryFile.path, entryFile.name)
        return
      }
    } catch {
      // Directory unreadable or empty; fall through to the explorer.
    }
    registry.openTab?.({ type: 'explorer' }, scope)
  }

  /** The mirror directory the 打开 button targets: last bound, else the first binding. */
  const targetMirrorPath = lastMirrorPath ?? bindings[0]?.mirrorPath

  const syncMirror = (mirror: OverleafBinding, direction: 'pull' | 'push'): void => {
    void run(async () => {
      const result = await overleafApi.sync(mirror.mirrorPath, direction)
      return `${mirror.projectName} ${direction === 'pull' ? '拉取' : '推送'}完成：${result.message}`
    })
  }

  const unbindMirror = (mirror: OverleafBinding): void => {
    void run(async () => {
      await overleafApi.unbind(mirror.mirrorPath)
      if (lastMirrorPath === mirror.mirrorPath) setLastMirrorPath(undefined)
      await refresh(workspace)
      return `已解绑 ${mirror.projectName}（本地文件保留）`
    })
  }

  const needle = projectFilter.trim().toLowerCase()
  const visibleProjects = useMemo(() => {
    if (needle === '') return projects
    return projects.filter(project =>
      project.name.toLowerCase().includes(needle) || project.id.toLowerCase().includes(needle))
  }, [projects, needle])

  return (
    <div style={S.page} className="dov-page">
      <style>{STYLE_SHEET}</style>

      <section style={S.card}>
        <h3 style={S.title}><LoginIcon size={15} /> 登录</h3>
        <div style={S.row}>
          <span style={{ ...S.chip, ...(loggedIn ? S.chipOk : S.chipBad) }}>
            {loggedIn ? '✓ 网页会话' : '✗ 网页未登录'}
          </span>
          <span style={{ ...S.chip, ...(gitConfigured ? S.chipOk : S.chipBad) }}>
            {gitConfigured ? '✓ 同步令牌' : '✗ 无同步令牌'}
          </span>
        </div>

        <div style={S.methodTitle}>方式一 · 浏览器登录（免费账号）</div>
        <div style={S.row}>
          <label style={{ ...S.field, flex: 0, minWidth: 170 }}>
            浏览器
            <select value={channel} onChange={event => { chooseChannel(event.target.value as Channel) }} disabled={busy} style={S.select} className="dov-select">
              <option value="auto">自动探测（推荐）</option>
              <option value="custom">指定浏览器路径</option>
              <option value="default">系统默认浏览器</option>
              <option value="msedge">Microsoft Edge</option>
              <option value="chrome">Google Chrome</option>
              <option value="real">真实浏览器配置（高级）</option>
            </select>
          </label>
          {channel === 'custom' && (
            <label style={{ ...S.field, minWidth: 220 }}>
              浏览器路径
              <input
                value={customPath}
                onChange={event => { chooseCustomPath(event.target.value) }}
                placeholder="D:/.../CentBrowser.exe"
                disabled={busy}
                style={S.input}
                className="dov-input"
              />
            </label>
          )}
          <button onClick={login} disabled={busy || (channel === 'custom' && customPath.trim() === '')} style={{ ...S.button, ...S.primary, alignSelf: 'flex-end' }} className="dov-btn dov-btn-primary">
            登录
          </button>
        </div>
        <ul style={S.bullets}>
          <li>独立配置：登录一次，之后免密；弹窗内也可用 Google 登录</li>
          <li>「真实浏览器配置」直接用日常浏览器的账号，但需先完全退出该浏览器</li>
          <li>其他浏览器：F12 → 应用 → Cookie → 复制 <code>overleaf_session2</code> 后点「粘贴」</li>
        </ul>
        {manualLogin !== null && (
          <div style={S.manual}>
            <textarea
              value={cookieDraft}
              onChange={event => { setCookieDraft(event.target.value) }}
              placeholder="overleaf_session2=MTA0..."
              disabled={busy}
              style={S.textarea}
              className="dov-input"
            />
            <button onClick={saveCookie} disabled={busy || cookieDraft.trim() === ''} style={{ ...S.button, ...S.primary, alignSelf: 'flex-start' }} className="dov-btn dov-btn-primary">
              保存
            </button>
          </div>
        )}

        <div style={S.methodTitle}>方式二 · Git 令牌（会员功能，无需浏览器）</div>
        {!gitTokenOpen ? (
          <div style={S.row}>
            <button onClick={() => { setGitTokenOpen(true) }} disabled={busy} style={S.button} className="dov-btn">
              填写令牌…
            </button>
            {gitConfigured && <span style={S.meta}>已配置 ✓</span>}
          </div>
        ) : (
          <div style={S.row}>
            <input
              type="password"
              value={gitTokenDraft}
              onChange={event => { setGitTokenDraft(event.target.value) }}
              placeholder="粘贴 git-integration token"
              disabled={busy}
              style={{ ...S.input, flex: 1, minWidth: 220, width: 'auto' }}
              className="dov-input"
            />
            <button onClick={saveGitToken} disabled={busy || gitTokenDraft.trim() === ''} style={{ ...S.button, ...S.primary }} className="dov-btn dov-btn-primary">
              保存
            </button>
            <button onClick={() => { setGitTokenOpen(false) }} disabled={busy} style={S.button} className="dov-btn">
              取消
            </button>
          </div>
        )}
        <ul style={S.bullets}>
          <li>Overleaf → 账户设置 → Git integration 中生成令牌</li>
          <li>启用 Git 双向同步（克隆 / 拉取 / 推送）；无令牌时 Pull 自动走网页快照（单向）</li>
        </ul>
      </section>

      <section style={S.card}>
        <h3 style={S.title}><ProjectsIcon size={15} /> 项目</h3>
        <div style={S.toolbar}>
          <div style={S.searchBox}>
            <span style={S.searchIcon}>🔍</span>
            <input
              value={projectFilter}
              onChange={event => { setProjectFilter(event.target.value) }}
              placeholder="搜索项目名或 ID…"
              disabled={!projectsLoaded}
              style={S.searchInput}
              className="dov-input"
              spellCheck={false}
            />
            {projectFilter !== '' && (
              <button
                onClick={() => { setProjectFilter('') }}
                style={S.clearBtn}
                className="dov-clear"
                title="清除搜索"
              >
                ✕
              </button>
            )}
          </div>
          <span style={S.count}>{projectsLoaded ? `${String(visibleProjects.length)}/${String(projects.length)}` : ''}</span>
          <button onClick={loadProjects} disabled={busy} style={{ ...S.button, ...S.primary }} className="dov-btn dov-btn-primary">刷新</button>
        </div>
        <div style={S.list} className="dov-list">
          {!projectsLoaded && <div style={S.empty}>点击「刷新」加载你的 Overleaf 项目</div>}
          {projectsLoaded && visibleProjects.length === 0 && (
            <div style={S.empty}>{projects.length === 0 ? '没有加载到项目' : '没有匹配的项目'}</div>
          )}
          {visibleProjects.map(project => (
            <button
              key={project.id}
              style={S.projectRow}
              className={selectedProject?.id === project.id ? 'dov-project dov-selected' : 'dov-project'}
              onClick={() => {
                setSelectedProject(project)
                setMirrorName(project.name)
              }}
              title={`${project.name}${project.updatedAt === undefined ? '' : ` · 最后编辑 ${project.updatedAt.slice(0, 10)}`}`}
            >
              <span className="dov-name">{project.name}</span>
              {project.updatedAt !== undefined && <span className="dov-date">{project.updatedAt.slice(0, 10)}</span>}
            </button>
          ))}
        </div>
      </section>

      <section style={S.card}>
        <h3 style={S.title}><BindIcon size={15} /> 绑定</h3>
        <div style={S.row}>
          <label style={S.field}>
            工作区目录
            <input
              value={workspacePath}
              onChange={event => { setWorkspacePath(event.target.value) }}
              placeholder={scope.cwd ?? 'D:/path/to/workspace'}
              disabled={busy}
              style={S.input}
              className="dov-input"
            />
          </label>
          <label style={{ ...S.field, flex: 0, minWidth: 140 }}>
            项目名（镜像目录名）
            <input
              value={mirrorName}
              onChange={event => { setMirrorName(event.target.value) }}
              placeholder={selectedProject?.name ?? 'my-paper'}
              disabled={busy}
              style={S.input}
              className="dov-input"
            />
          </label>
        </div>
        <div style={S.row}>
          <label style={{ ...S.field, flex: 1, minWidth: 200 }}>
            项目 ID{selectedProject === null ? '（未选列表项时可手填 Overleaf 网址末段）' : ''}
            <input
              value={selectedProject?.id ?? manualProjectId}
              onChange={event => { setManualProjectId(event.target.value); setSelectedProject(null) }}
              placeholder="32 位十六进制，如 5f3f7e…"
              disabled={busy}
              style={S.input}
              className="dov-input"
              spellCheck={false}
            />
          </label>
          <label style={{ ...S.field, flex: 0, minWidth: 170 }}>
            传输
            <select value={transport} onChange={event => { setTransport(event.target.value as OverleafTransportKind | 'auto') }} disabled={busy} style={S.select} className="dov-select">
              <option value="auto">自动（优先 Git，双向）</option>
              <option value="git">Git 同步（双向，需令牌）</option>
              <option value="api">网页快照（仅拉取，免令牌）</option>
            </select>
          </label>
          <button
            onClick={bind}
            disabled={busy || effectiveProjectId === '' || workspace === ''}
            style={{ ...S.button, ...S.primary, alignSelf: 'flex-end' }}
            className="dov-btn dov-btn-primary"
          >
            绑定并拉取
          </button>
          <button
            onClick={() => { if (targetMirrorPath !== undefined) void openMirrorInSidebar(targetMirrorPath) }}
            disabled={busy || targetMirrorPath === undefined}
            style={{ ...S.button, alignSelf: 'flex-end' }}
            className="dov-btn"
            title="在侧边栏打开该项目的入口文件（优先 main.tex）"
          >
            打开文件
          </button>
        </div>
      </section>

      <section style={S.card}>
        <h3 style={S.title}><SyncIcon size={15} /> 已绑定镜像</h3>
        {bindings.length === 0 && <p style={S.hint}>当前工作区还没有绑定的镜像。</p>}
        <div style={{ ...S.list, maxHeight: 240 }} className="dov-list">
          {bindings.map(mirror => (
            <div key={mirror.mirrorPath} style={S.mirrorRow}>
              <div style={S.row}>
                <strong>{mirror.projectName}</strong>
                <span style={S.meta}>{mirror.transport === 'auto' ? 'auto' : mirror.transport}</span>
              </div>
              <span style={S.meta}>{mirror.mirrorPath}</span>
              <div style={S.row}>
                <button onClick={() => { syncMirror(mirror, 'pull') }} disabled={busy} style={{ ...S.button, ...S.primary }} className="dov-btn dov-btn-primary">
                  Pull
                </button>
                <button onClick={() => { syncMirror(mirror, 'push') }} disabled={busy} style={S.button} className="dov-btn">
                  Push
                </button>
                <button
                  onClick={() => { void openMirrorInSidebar(mirror.mirrorPath) }}
                  disabled={busy}
                  style={S.button}
                  className="dov-btn"
                  title="在编辑器中打开该镜像的入口文件（优先 main.tex）"
                >
                  打开
                </button>
                <button onClick={() => { unbindMirror(mirror) }} disabled={busy} style={{ ...S.button, ...S.danger }} className="dov-btn" title="仅移除绑定关系，本地文件保留">
                  解绑
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {message !== '' && <div role="status" style={S.status}>{message}</div>}
      {error !== '' && <div role="alert" style={S.error}>{error}</div>}
    </div>
  )
}
