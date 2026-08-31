/**
 * The bound-mirror list: per-mirror live status line and row actions. Clicking
 * a row makes it the sync toolbar's target.
 */
import type { ReactElement } from 'react'
import type { OverleafBinding, OverleafRemoteStatus } from '../../types.ts'
import { ACCENT, BORDER, LABEL_2, OK, WARN, button, card, cardTitle, meta, relativeTime, row } from './tokens.ts'

export interface BindingsListProps {
  bindings: OverleafBinding[]
  /** Latest remote status per mirror path. */
  statuses: ReadonlyMap<string, OverleafRemoteStatus>
  /** The mirror the sync toolbar currently drives. */
  selectedPath: string | undefined
  busy: boolean
  onSelect: (mirrorPath: string) => void
  onPull: (mirror: OverleafBinding) => void
  onPush: (mirror: OverleafBinding) => void
  onOpen: (mirror: OverleafBinding) => void
  onUnbind: (mirror: OverleafBinding) => void
  /** Upgrade a snapshot-only mirror to two-way git sync. */
  onUpgrade: (mirror: OverleafBinding) => void
}

/** One-line status summary for a mirror. */
function statusLine(status: OverleafRemoteStatus | undefined): ReactElement {
  if (status === undefined) return <span style={meta}>检查中…</span>
  if (!status.remoteAvailable) return <span style={meta}>快照模式 · 双向（网页端点）</span>
  const bits: string[] = []
  if (status.behind > 0) bits.push(`↓ ${String(status.behind)}`)
  if (status.ahead > 0) bits.push(`↑ ${String(status.ahead)}`)
  if (status.dirty) bits.push(`${String(status.dirtyCount)} 处修改`)
  if (bits.length === 0) return <span style={{ ...meta, color: OK }}>已同步</span>
  return (
    <span style={{ ...meta, color: status.behind > 0 ? WARN : LABEL_2 }}>
      {bits.join(' · ')}
      {status.remoteCommitTime !== undefined ? ` · 远端 ${relativeTime(status.remoteCommitTime)}` : ''}
    </span>
  )
}

/** The bound-mirrors card. */
export function BindingsList(props: BindingsListProps): ReactElement {
  if (props.bindings.length === 0) return <>{null}</>
  return (
    <section style={card}>
      <div style={cardTitle}>已绑定项目</div>
      <div style={{ ...{ display: 'flex', flexDirection: 'column', gap: 4 }, maxHeight: 220, overflowY: 'auto' }} className="dov-list">
        {props.bindings.map(mirror => {
          const status = props.statuses.get(mirror.mirrorPath)
          const selected = props.selectedPath === mirror.mirrorPath
          return (
            <div
              key={mirror.mirrorPath}
              onClick={() => { props.onSelect(mirror.mirrorPath) }}
              style={{
                display: 'flex', flexDirection: 'column', gap: 5, padding: '8px 10px',
                borderRadius: 8, cursor: 'pointer', boxSizing: 'border-box',
                border: `1px solid ${selected ? ACCENT : BORDER}`,
                background: selected ? 'var(--dsw-alias-bg-multi-select, rgba(31,138,91,0.08))' : 'transparent',
              }}
              className="dov-row-item"
            >
              <div style={{ ...row, justifyContent: 'space-between' }}>
                <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {mirror.projectName}
                </strong>
                {statusLine(status)}
              </div>
              <div style={{ ...row, gap: 6 }}>
                <button
                  onClick={event => { event.stopPropagation(); props.onPull(mirror) }}
                  disabled={props.busy}
                  style={{ ...button, padding: '3px 10px', fontSize: 12, color: ACCENT, borderColor: ACCENT }}
                  className="dov-btn"
                >
                  拉取
                </button>
                <button
                  onClick={event => { event.stopPropagation(); props.onPush(mirror) }}
                  disabled={props.busy}
                  style={{ ...button, padding: '3px 10px', fontSize: 12 }}
                  className="dov-btn"
                  title={status?.remoteAvailable === false ? '快照推送：把本地修改通过网页端点写回 Overleaf' : '推送到 Overleaf'}
                >
                  推送
                </button>
                {status?.remoteAvailable === false && (
                  <button
                    onClick={event => { event.stopPropagation(); props.onUpgrade(mirror) }}
                    disabled={props.busy}
                    style={{ ...button, padding: '3px 10px', fontSize: 12, color: WARN, borderColor: WARN }}
                    className="dov-btn"
                    title="把当前内容叠加到 Overleaf 的 Git 历史上，切换为可推送的双向同步（需要 Git 令牌）"
                  >
                    切换 Git 双向
                  </button>
                )}
                <button
                  onClick={event => { event.stopPropagation(); props.onOpen(mirror) }}
                  disabled={props.busy}
                  style={{ ...button, padding: '3px 10px', fontSize: 12 }}
                  className="dov-btn"
                >
                  打开
                </button>
                <span style={{ flex: 1 }} />
                <button
                  onClick={event => { event.stopPropagation(); props.onUnbind(mirror) }}
                  disabled={props.busy}
                  style={{ ...button, padding: '3px 10px', fontSize: 12, color: 'var(--dsw-alias-danger, #d24f4f)', border: 'none' }}
                  className="dov-btn"
                  title="仅移除绑定关系，本地文件保留"
                >
                  解绑
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
