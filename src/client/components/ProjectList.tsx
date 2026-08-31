/**
 * Searchable Overleaf project list. Loads automatically once logged in
 * (container-driven); clicking a project expands an inline bind row — no more
 * hunting through a third form to bind a project into the workspace.
 */
import { useState } from 'react'
import type { ReactElement } from 'react'
import type { OverleafProject, OverleafTransportKind } from '../../types.ts'
import { BindIcon } from '../icons.tsx'
import { BORDER, LABEL_3, OK, button, card, cardTitle, empty, input, meta, primary, relativeTime, row } from './tokens.ts'

/** One project row action set. */
export interface ProjectListProps {
  projects: OverleafProject[]
  /** Whether the first load finished (drives the empty state). */
  loaded: boolean
  /** Projects already bound in this workspace (by id). */
  boundIds: ReadonlySet<string>
  busy: boolean
  error: string | undefined
  onBind: (project: OverleafProject, name: string, transport: OverleafTransportKind | 'auto') => void
  onReload: () => void
}

/** Inline bind confirmation shown under the clicked project. */
function BindRow({ project, busy, onBind }: {
  project: OverleafProject
  busy: boolean
  onBind: (project: OverleafProject, name: string, transport: OverleafTransportKind | 'auto') => void
}): ReactElement {
  const [name, setName] = useState(project.name)
  const [transport, setTransport] = useState<OverleafTransportKind | 'auto'>('auto')
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 7, width: '100%',
        padding: '8px 10px', borderRadius: 8, border: `1px dashed ${BORDER}`, marginTop: 2,
        boxSizing: 'border-box',
      }}
    >
      <div style={row}>
        <label style={{ ...row, gap: 5, fontSize: 12, flex: 1, minWidth: 150 }}>
          目录名
          <input
            value={name}
            onChange={event => { setName(event.target.value) }}
            disabled={busy}
            style={{ ...input, padding: '4px 8px' }}
            className="dov-input"
          />
        </label>
        <select
          value={transport}
          onChange={event => { setTransport(event.target.value as OverleafTransportKind | 'auto') }}
          disabled={busy}
          style={{ ...input, width: 'auto', padding: '4px 6px' }}
          className="dov-select"
        >
          <option value="auto">自动</option>
          <option value="git">Git 双向</option>
          <option value="api">快照只读</option>
        </select>
      </div>
      <div style={row}>
        <button
          onClick={() => { onBind(project, name, transport) }}
          disabled={busy || name.trim() === ''}
          style={{ ...button, ...primary }}
          className="dov-btn dov-btn-primary"
        >
          绑定并拉取
        </button>
        <span style={meta}>拉取到当前工作区的 overleaf/ 目录</span>
      </div>
    </div>
  )
}

/** The project list card. */
export function ProjectList(props: ProjectListProps): ReactElement {
  const [filter, setFilter] = useState('')
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined)
  const needle = filter.trim().toLowerCase()
  const visible = needle === ''
    ? props.projects
    : props.projects.filter(project =>
        project.name.toLowerCase().includes(needle) || project.id.toLowerCase().includes(needle))
  return (
    <section style={card}>
      <div style={{ ...cardTitle, justifyContent: 'space-between' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <BindIcon size={15} /> 我的项目
        </span>
        <button
          onClick={props.onReload}
          disabled={props.busy}
          style={{ ...button, padding: '3px 10px', fontSize: 12, color: LABEL_3 }}
          className="dov-btn"
          title="从 Overleaf 重新拉取项目列表"
        >
          刷新
        </button>
      </div>
      {props.projects.length > 6 && (
        <input
          value={filter}
          onChange={event => { setFilter(event.target.value) }}
          placeholder="搜索项目…"
          disabled={props.busy}
          style={{ ...input, padding: '5px 9px' }}
          className="dov-input"
          spellCheck={false}
        />
      )}
      {!props.loaded && <div style={empty}>{props.error !== undefined ? props.error : '正在加载项目列表…'}</div>}
      {props.loaded && visible.length === 0 && (
        <div style={empty}>{props.projects.length === 0 ? '没有加载到项目' : '没有匹配的项目'}</div>
      )}
      <div style={{ ...{ display: 'flex', flexDirection: 'column', gap: 2 }, maxHeight: 260, overflowY: 'auto' }} className="dov-list">
        {visible.map(project => {
          const bound = props.boundIds.has(project.id)
          const expanded = expandedId === project.id
          return (
            <div key={project.id} style={{ display: 'flex', flexDirection: 'column' }}>
              <button
                onClick={() => { setExpandedId(expanded ? undefined : project.id) }}
                disabled={props.busy}
                style={{
                  display: 'flex', alignItems: 'center', width: '100%', gap: 8,
                  padding: '7px 9px', borderRadius: 7, border: '1px solid transparent',
                  background: expanded ? 'var(--dsw-alias-bg-multi-select, rgba(31,138,91,0.10))' : 'transparent',
                  color: 'inherit', cursor: 'pointer', fontSize: 13, textAlign: 'left',
                }}
                className="dov-row-item"
                title={bound ? '已绑定到当前工作区' : '点击绑定到当前工作区'}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {project.name}
                </span>
                {bound && <span style={{ ...meta, color: OK, flex: 'none' }}>已绑定</span>}
                {project.updatedAt !== undefined && (
                  <span style={{ ...meta, flex: 'none' }}>{relativeTime(project.updatedAt)}</span>
                )}
              </button>
              {expanded && !bound && (
                <BindRow project={project} busy={props.busy} onBind={props.onBind} />
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
