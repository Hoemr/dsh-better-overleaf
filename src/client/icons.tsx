/**
 * Inline SVG icons for the Overleaf tab. Kept dependency-free and currentColor
 * based so they follow the sidebar theme automatically.
 */
import type { CSSProperties } from 'react'

/** Shared icon props. */
interface IconProps {
  /** Rendered width/height in pixels. */
  size?: number
}

/** Base SVG style for one icon. */
function svgStyle(size: number): CSSProperties {
  return { display: 'block', flex: 'none', width: size, height: size }
}

/** Overleaf tab glyph: a leaf over a document fold. */
export function OverleafIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={svgStyle(size)} aria-hidden="true">
      <path
        d="M6 21h12a2 2 0 0 0 2-2V7.5L14.5 2H6a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M15.5 2v5h5M7.5 18.5c5 0 9-3.5 10-10-6.5.5-10 4.5-10 10Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9.5 17.5c2.5-4 5-6.5 8-8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Login section glyph: a key. */
export function LoginIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={svgStyle(size)} aria-hidden="true">
      <circle cx="8" cy="14" r="4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M11 11 18 4m-3 3 2.5 2.5M19 2l3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/** Projects section glyph: a folder. */
export function ProjectsIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={svgStyle(size)} aria-hidden="true">
      <path
        d="M3 6.5h7l2 2h9v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Bind section glyph: a chain link. */
export function BindIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={svgStyle(size)} aria-hidden="true">
      <path
        d="M9.5 14.5 14.5 9.5M8 11l-2.5 2.5a3.54 3.54 0 0 0 5 5L13 16m3-3 2.5-2.5a3.54 3.54 0 0 0-5-5L11 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Sync section glyph: two circular arrows. */
export function SyncIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={svgStyle(size)} aria-hidden="true">
      <path
        d="M20 12a8 8 0 0 1-14 5l-2 2m0-5h5M4 12a8 8 0 0 1 14-5l2 2m0 5h-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
