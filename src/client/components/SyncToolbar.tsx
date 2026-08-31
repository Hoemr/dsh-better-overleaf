/**
 * The always-on-top sync toolbar: the bound project's live remote position and
 * the pull/push/compile actions, so sync never needs scrolling to reach.
 */
import type { ReactElement } from 'react'
import type { OverleafBinding, OverleafRemoteStatus } from '../../types.ts'
import { CheckRemoteIcon, CompileIcon, PullIcon, PushIcon, SettingsIcon } from '../icons.tsx'
import { ACCENT, BORDER, LABEL_2, LABEL_3, OK, WARN, button, meta, pill, primary, relativeTime, row } from './tokens.ts'

/** One toolbar action callback set. */
export interface SyncToolbarProps {
  /** The mirror this toolbar drives (first/selected binding). */
  mirror: OverleafBinding
  /** Its latest remote status, when loaded. */
  status: OverleafRemoteStatus | undefined
  /** Global busy latch. */
  busy: boolean
  /** Whether latexmk was detected (enables 编译预览). */
  latexmkAvailable: boolean
  onPull: () => void
  onPush: () => void
  onCheck: () => void
  onCompile: () => void
  onOpenSettings: () => void
  onOpenMirror: () => void
}

/** Status pill describing the remote position in one line. */
function StatusPills({ status }: { status: OverleafRemoteStatus | undefined }): ReactElement {
  if (status === undefined) {
    return <span style={{ ...pill, color: LABEL_3 }}>正在检查更新…</span>
  }
  if (!status.remoteAvailable) {
    return (
      <span style={{ ...pill, color: LABEL_2 }} title="快照模式：通过网页端点拉取和推送，无需 Git 令牌">
        快照模式 · 双向
      </span>
    )
  }
  const parts: ReactElement[] = []
  if (status.behind > 0) {
    parts.push(
      <span key="behind" style={{ ...pill, color: WARN, borderColor: WARN }} title="远端有新提交，点「拉取更新」获取">
        ↓ {String(status.behind)} 个待拉取
      </span>,
    )
  }
  if (status.ahead > 0) {
    parts.push(
      <span key="ahead" style={{ ...pill, color: OK }} title="本地有修改待推送">
        ↑ {String(status.ahead)} 个待推送
      </span>,
    )
  }
  if (status.dirty) {
    parts.push(
      <span key="dirty" style={{ ...pill, color: LABEL_2 }} title={`${String(status.dirtyCount)} 个文件未提交`}>
        {String(status.dirtyCount)} 处本地修改
      </span>,
    )
  }
  if (parts.length === 0) {
    parts.push(
      <span key="clean" style={{ ...pill, color: OK }}>
        ✓ 已同步
      </span>,
    )
  }
  return <>{parts}</>
}

/** The sync toolbar card. */
export function SyncToolbar(props: SyncToolbarProps): ReactElement {
  const { mirror, status, busy, latexmkAvailable } = props
  const remoteUpdated = status === undefined ? '' : relativeTime(status.remoteCommitTime)
  const lastSynced = relativeTime(status?.lastSyncTime)
  return (
    <section
      style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        border: `1px solid ${BORDER}`, borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
        padding: '10px 12px', flexShrink: 0,
        boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}
    >
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <button
          onClick={props.onOpenMirror}
          disabled={busy}
          className="dov-btn"
          title="在侧边栏打开入口文件（优先 main.tex）"
          style={{
            border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
            fontSize: 14, fontWeight: 700, padding: 0, textAlign: 'left',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {mirror.projectName}
        </button>
        <div style={{ ...row, gap: 5 }}>
          <StatusPills status={status} />
        </div>
      </div>
      {(remoteUpdated !== '' || lastSynced !== '') && (
        <div style={{ ...meta, marginTop: -3 }}>
          {remoteUpdated !== '' && <>远端更新于 {remoteUpdated}</>}
          {remoteUpdated !== '' && lastSynced !== '' && ' · '}
          {lastSynced !== '' && <>上次同步 {lastSynced}</>}
        </div>
      )}
      <div style={row}>
        <button
          onClick={props.onPull}
          disabled={busy}
          style={{ ...button, ...primary }}
          className="dov-btn dov-btn-primary"
          title={status?.remoteAvailable === false ? '拉取 Overleaf 最新快照覆盖本地（本地修改会先自动提交，可从历史找回）' : '拉取远端新提交；本地修改会自动提交并变基合并'}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <PullIcon size={14} /> 拉取更新
          </span>
        </button>
        <button
          onClick={props.onPush}
          disabled={busy}
          style={button}
          className="dov-btn"
          title="把本地修改推送到 Overleaf：快照模式通过网页端点逐个上传/删除；Git 模式走官方 git bridge"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <PushIcon size={14} /> 推送修改
          </span>
        </button>
        <button
          onClick={props.onCheck}
          disabled={busy}
          style={{ ...button, color: LABEL_2 }}
          className="dov-btn"
          title="重新检查与 Overleaf 远端的差异"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <CheckRemoteIcon size={13} /> 检查
          </span>
        </button>
        <span style={{ flex: 1 }} />
        {latexmkAvailable && (
          <button
            onClick={props.onCompile}
            disabled={busy}
            style={{ ...button, color: ACCENT, borderColor: ACCENT }}
            className="dov-btn"
            title="本地 latexmk 编译并在 PDF 阅读器中打开"
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <CompileIcon size={13} /> 编译预览
            </span>
          </button>
        )}
        <button
          onClick={props.onOpenSettings}
          disabled={busy}
          style={{ ...button, color: LABEL_2 }}
          className="dov-btn"
          title="登录、自动同步等设置"
        >
          <SettingsIcon size={14} />
        </button>
      </div>
    </section>
  )
}
