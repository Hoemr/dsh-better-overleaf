/**
 * Shared design tokens and small style atoms for the Overleaf tab. Colors ride
 * the host's `--dsw-alias-*` variables with literal fallbacks, so light/dark
 * themes follow the sidebar automatically; the one injected stylesheet adds the
 * hover/focus states inline styles cannot express.
 */
import type { CSSProperties } from 'react'

export const ACCENT = '#1f8a5b'
export const INK = 'var(--dsw-alias-label-inverted, #fff)'
export const BG = 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05))'
export const BG_HOVER = 'var(--dsw-alias-bg-skeleton, rgba(127,127,127,0.09))'
export const BORDER = 'var(--dsw-alias-border-l2, rgba(127,127,127,0.22))'
export const LABEL_2 = 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.85))'
export const LABEL_3 = 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.6))'
export const OK = 'var(--dsw-alias-state-success, #2e9e63)'
export const WARN = 'var(--dsw-alias-state-warn, #d3901c)'
export const DANGER = 'var(--dsw-alias-danger, #d24f4f)'

/** Card container. */
export const card: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px',
  border: `1px solid ${BORDER}`, borderRadius: 10, background: BG, flexShrink: 0,
}

/** Card heading row. */
export const cardTitle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 7, margin: 0,
  fontSize: 13, fontWeight: 600,
}

/** Horizontal wrap row. */
export const row: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }

/** Shared input/select skin. */
export const input: CSSProperties = {
  padding: '6px 9px', borderRadius: 7, border: `1px solid ${BORDER}`,
  background: 'transparent', color: 'inherit', fontSize: 13, outline: 'none',
  width: '100%', boxSizing: 'border-box',
}

/** Secondary button (theme outline). */
export const button: CSSProperties = {
  padding: '6px 12px', borderRadius: 7, border: `1px solid ${BORDER}`,
  background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 13,
  transition: 'background 120ms ease, border-color 120ms ease', whiteSpace: 'nowrap',
} satisfies CSSProperties

/** Primary (accent-filled) button skin applied over `button`. */
export const primary: CSSProperties = {
  background: ACCENT, borderColor: ACCENT, color: INK, fontWeight: 600,
}

/** Danger text button skin applied over `button`. */
export const danger: CSSProperties = { color: DANGER, borderColor: BORDER }

/** Small status pill. */
export const pill: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px',
  borderRadius: 999, fontSize: 12, border: `1px solid ${BORDER}`, whiteSpace: 'nowrap',
}

/** Small gray meta text. */
export const meta: CSSProperties = { fontSize: 11, color: LABEL_3, wordBreak: 'break-all' }

/** Empty-state placeholder. */
export const empty: CSSProperties = { opacity: 0.5, fontSize: 12, textAlign: 'center', padding: '14px 0' }

/** Scrollable list column. */
export const list: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 3,
  overflowY: 'auto', paddingRight: 2,
}

/** Theme-following states the inline styles cannot express (`dov-` namespace). */
export const SHEET = `
.dov-page::-webkit-scrollbar, .dov-list::-webkit-scrollbar { width: 8px; height: 8px; }
.dov-page::-webkit-scrollbar-thumb, .dov-list::-webkit-scrollbar-thumb {
  background: var(--dsh-scrollbar-thumb, rgba(127,127,127,0.30)); border-radius: 4px;
}
.dov-page::-webkit-scrollbar-thumb:hover, .dov-list::-webkit-scrollbar-thumb:hover {
  background: var(--dsh-scrollbar-thumb-hover, rgba(127,127,127,0.45));
}
.dov-page::-webkit-scrollbar-track, .dov-list::-webkit-scrollbar-track { background: transparent; }
.dov-select option { background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #222); }
.dov-btn:hover { background: ${BG_HOVER} !important; }
.dov-btn:disabled { opacity: 0.45; cursor: default; }
.dov-btn:disabled:hover { background: transparent !important; }
.dov-btn-primary:hover:not(:disabled) { filter: brightness(1.12) !important; }
.dov-btn-primary:disabled:hover { background: ${ACCENT} !important; }
.dov-input:focus, .dov-select:focus { border-color: ${ACCENT} !important; }
.dov-row-item { outline: none; }
.dov-row-item:hover { background: var(--dsw-alias-bg-skeleton, rgba(127,127,127,0.08)) !important; }
.dov-row-item:focus-visible { outline: 1px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.4)); outline-offset: -1px; }
`

/** Relative-time formatter (「3 分钟前」) with a minute floor. */
export function relativeTime(iso: string | undefined): string {
  if (iso === undefined || iso === '') return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const delta = Date.now() - then
  if (delta < 0) return '刚刚'
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${String(days)} 天前`
  return iso.slice(0, 10)
}
