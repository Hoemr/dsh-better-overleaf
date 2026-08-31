/**
 * Full-featured PDF viewer for the sidebar workbench, replacing the built-in
 * iframe/PDFium preview (no zoom, no search, no outline). Backed by pdf.js:
 * continuous scrolling with lazy per-page canvas rendering, Ctrl+wheel zoom,
 * fit-width, page jump, outline sidebar, full-text search with hit counts,
 * selectable text layer, and a dark-mode invert that keeps colors sane.
 * Registered at a priority above the built-in viewer, so every .pdf in the
 * sidebar opens here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerCode from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { BORDER, LABEL_2, LABEL_3, button, input, row } from './components/tokens.ts'

/** One-time pdf.js worker bootstrap from an inlined blob (no network). */
let workerBootstrapped = false
function ensureWorker(): void {
  if (workerBootstrapped) return
  workerBootstrapped = true
  const blob = new Blob([workerCode], { type: 'text/javascript' })
  pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob)
}

/** Outline tree entry (mirrors pdfjs structure loosely). */
interface OutlineItem {
  title: string
  dest: unknown
  items: OutlineItem[]
}

/** A resolved outline row: title + page index. */
interface OutlineRow {
  title: string
  pageIndex: number
  depth: number
}

/** Style constants. */
const toolbarStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
  borderBottom: `1px solid ${BORDER}`, flex: 'none', flexWrap: 'wrap',
}

const smallButton: CSSProperties = {
  ...button, padding: '3px 8px', fontSize: 12, border: 'none', color: LABEL_2,
}

/** Viewer stylesheet: text selection layer + dark invert. */
const PDF_SHEET = `
.dov-pdf-scroll { scrollbar-width: thin; }
.dov-pdf-scroll::-webkit-scrollbar { width: 8px; }
.dov-pdf-scroll::-webkit-scrollbar-thumb { background: var(--dsh-scrollbar-thumb, rgba(127,127,127,0.30)); border-radius: 4px; }
.dov-pdf-page { position: relative; margin: 0 auto 10px; box-shadow: 0 1px 6px rgba(0,0,0,0.18); background: #fff; }
.dov-pdf-page canvas { display: block; }
.dov-pdf-textlayer { position: absolute; inset: 0; overflow: hidden; line-height: 1; opacity: 1; }
.dov-pdf-textlayer span { position: absolute; color: transparent; cursor: text; transform-origin: 0% 0%; white-space: pre; }
.dov-pdf-textlayer ::selection { background: rgba(63,131,235,0.35); }
.dov-pdf-textlayer .dov-highlight { background: rgba(255,196,0,0.45); border-radius: 1px; }
body[data-ds-dark-theme] .dov-pdf-page { background: #1b1b1d; }
body[data-ds-dark-theme] .dov-pdf-page canvas { filter: invert(0.90) hue-rotate(180deg); }
body[data-ds-dark-theme] .dov-pdf-textlayer ::selection { background: rgba(63,131,235,0.5); }
`

/** Text content of one page joined for search (normalized whitespace). */
async function pageText(document: PDFDocumentProxy, pageNumber: number): Promise<string> {
  const page = await document.getPage(pageNumber)
  const content = await page.getTextContent()
  return content.items.map(item => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ')
}

/** The PDF viewer component registered as the sidebar's .pdf handler. */
export function PdfViewer(props: {
  mediaUrl?: string
  path: string
  title: string
}): ReactElement {
  const { mediaUrl, title } = props
  const [document, setDocument] = useState<PDFDocumentProxy | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pageCount, setPageCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [jumpDraft, setJumpDraft] = useState('')
  const [zoom, setZoom] = useState<number | 'fit-width'>('fit-width')
  const [outline, setOutline] = useState<OutlineRow[]>([])
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [searchDraft, setSearchDraft] = useState('')
  const [searchState, setSearchState] = useState<{ pages: number[]; index: number; total: number } | undefined>(undefined)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const renderedRef = useRef<Set<number>>(new Set())
  const fitWidthRef = useRef(true)
  const containerWidthRef = useRef(0)

  fitWidthRef.current = zoom === 'fit-width'

  /** Load the document + outline once the media URL arrives. */
  useEffect(() => {
    if (mediaUrl === undefined) return
    let cancelled = false
    const controller = new AbortController()
    void (async (): Promise<void> => {
      try {
        ensureWorker()
        const response = await fetch(mediaUrl, { signal: controller.signal })
        if (!response.ok) throw new Error(`PDF 加载失败 (HTTP ${String(response.status)})`)
        const data = new Uint8Array(await response.arrayBuffer())
        const loaded = await pdfjs.getDocument({ data }).promise
        if (cancelled) {
          void loaded.destroy()
          return
        }
        setDocument(loaded)
        setPageCount(loaded.numPages)
        const rawOutline = await loaded.getOutline().catch(() => [])
        const rows: OutlineRow[] = []
        const walk = async (items: OutlineItem[], depth: number): Promise<void> => {
          for (const item of items) {
            try {
              const dest = typeof item.dest === 'string' ? await loaded.getDestination(item.dest) : item.dest
              if (Array.isArray(dest) && dest[0] !== null && typeof dest[0] === 'object') {
                const pageIndex = await loaded.getPageIndex(dest[0] as { num: number; gen: number })
                rows.push({ title: item.title, pageIndex, depth })
              }
            } catch {
              // Unresolvable dest; skip the entry.
            }
            if (item.items !== undefined && item.items.length > 0) await walk(item.items, depth + 1)
          }
        }
        await walk(rawOutline as OutlineItem[], 0)
        if (!cancelled) setOutline(rows)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
      void document?.destroy().catch(() => undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaUrl])

  /** Render one page onto its canvas (skipped when already drawn). */
  const renderPage = useCallback(async (pageNumber: number): Promise<void> => {
    const loaded = document
    const holder = pageRefs.current.get(pageNumber)
    if (loaded === undefined || holder === undefined || renderedRef.current.has(pageNumber)) return
    renderedRef.current.add(pageNumber)
    try {
      const page = await loaded.getPage(pageNumber)
      const cssWidth = fitWidthRef.current
        ? Math.max(320, containerWidthRef.current - 20)
        : Math.round(612 * (zoom as number))
      const base = page.getViewport({ scale: 1 })
      const scale = cssWidth / base.width
      const viewport = page.getViewport({ scale })
      const canvas = document_().createElement('canvas')
      const dpr = Math.min(2.5, globalThis.devicePixelRatio || 1)
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${String(Math.floor(viewport.width))}px`
      canvas.style.height = `${String(Math.floor(viewport.height))}px`
      const context = canvas.getContext('2d')
      if (context === null) return
      page.render({ canvasContext: context, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
        .promise.catch(() => undefined)
      holder.replaceChildren(canvas)
      // Text selection layer (best-effort; a failure only costs selection).
      try {
        const TextLayerCtor = (pdfjs as unknown as {
          TextLayer?: new (options: Record<string, unknown>) => { render: () => Promise<void> }
        }).TextLayer
        if (TextLayerCtor !== undefined) {
          const textLayerDiv = document_().createElement('div')
          textLayerDiv.className = 'dov-pdf-textlayer'
          textLayerDiv.style.setProperty('--scale-factor', String(scale))
          const textLayer = new TextLayerCtor({
            textContentSource: page.streamTextContent({ includeMarkedContent: false }),
            container: textLayerDiv,
            viewport,
          })
          holder.append(textLayerDiv)
          await textLayer.render().catch(() => undefined)
        }
      } catch {
        // TextLayer unavailable in this build; plain canvas remains.
      }
    } catch {
      renderedRef.current.delete(pageNumber)
    }
    // `document` name collision: grab the DOM document lazily via a helper.
    function document_(): Document {
      return globalThis.document
    }
  }, [document, zoom])

  /** Re-render everything when the zoom mode changes. */
  useEffect(() => {
    if (document === undefined) return
    renderedRef.current = new Set()
    for (const [, holder] of pageRefs.current) holder.replaceChildren()
    for (const pageNumber of pageRefs.current.keys()) void renderPage(pageNumber)
  }, [zoom, document, renderPage])

  /** Track the topmost visible page while scrolling. */
  const onScroll = useCallback((): void => {
    const scroller = scrollRef.current
    if (scroller === null) return
    const focus = scroller.scrollTop + 80
    let current = 1
    for (const [pageNumber, holder] of pageRefs.current) {
      if (holder.offsetTop <= focus) current = pageNumber
    }
    setCurrentPage(current)
  }, [])

  /** Lazy render pages as they approach the viewport. */
  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller === null || document === undefined) return
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const pageNumber = Number.parseInt((entry.target as HTMLElement).dataset.page ?? '0', 10)
        if (pageNumber > 0) void renderPage(pageNumber)
      }
    }, { root: scroller, rootMargin: '600px 0px' })
    for (const [, holder] of pageRefs.current) observer.observe(holder)
    return () => { observer.disconnect() }
  }, [document, pageCount, renderPage])

  /** Keep container width for fit-width recompute. */
  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller === null) return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0
      if (Math.abs(width - containerWidthRef.current) > 2) {
        containerWidthRef.current = width
        if (fitWidthRef.current && document !== undefined) {
          renderedRef.current = new Set()
          for (const [, holder] of pageRefs.current) holder.replaceChildren()
          for (const pageNumber of pageRefs.current.keys()) void renderPage(pageNumber)
        }
      }
    })
    observer.observe(scroller)
    return () => { observer.disconnect() }
  }, [document, renderPage])

  /** Jump to a page (also used by outline + search). */
  const goToPage = useCallback((pageNumber: number): void => {
    const clamped = Math.max(1, Math.min(pageCount, pageNumber))
    pageRefs.current.get(clamped)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setCurrentPage(clamped)
  }, [pageCount])

  /** Full-text search: count per-page hits, then walk them. */
  const runSearch = useCallback(async (needle: string): Promise<void> => {
    if (document === undefined || needle.trim() === '') {
      setSearchState(undefined)
      return
    }
    const lowered = needle.trim().toLowerCase()
    const pages: number[] = []
    let total = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const text = await pageText(document, pageNumber)
      const hits = text.toLowerCase().split(lowered).length - 1
      if (hits > 0) {
        pages.push(pageNumber)
        total += hits
      }
    }
    setSearchState({ pages, index: 0, total })
    if (pages.length > 0) goToPage(pages[0] ?? 1)
  }, [document, goToPage])

  const stepSearch = useCallback((delta: 1 | -1): void => {
    setSearchState(previous => {
      if (previous === undefined || previous.pages.length === 0) return previous
      const index = (previous.index + delta + previous.pages.length) % previous.pages.length
      const target = previous.pages[index]
      if (target !== undefined) goToPage(target)
      return { ...previous, index }
    })
  }, [goToPage])

  /** Flatten zoom steps shared by buttons and Ctrl+wheel. */
  const zoomStep = useCallback((delta: 1 | -1): void => {
    setZoom(previous => {
      const current = previous === 'fit-width' ? 1.2 : previous
      const next = Math.max(0.4, Math.min(4, Math.round((current + delta * 0.15) * 100) / 100))
      return next
    })
  }, [])

  const onWheel = useCallback((event: React.WheelEvent): void => {
    if (!event.ctrlKey) return
    event.preventDefault()
    zoomStep(event.deltaY < 0 ? 1 : -1)
  }, [zoomStep])

  const pagePlaceholders = useMemo(
    () => Array.from({ length: pageCount }, (_, index) => index + 1),
    [pageCount],
  )

  if (mediaUrl === undefined) {
    return <div style={{ padding: 14, color: LABEL_3, fontSize: 12 }}>正在加载 PDF…</div>
  }
  if (error !== undefined) {
    return <div style={{ padding: 14, color: 'var(--dsw-alias-danger, #d24f4f)', fontSize: 12, whiteSpace: 'pre-wrap' }}>{error}</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <style>{PDF_SHEET}</style>
      <div style={toolbarStyle} className="dov-toolbar">
        <button onClick={() => { setOutlineOpen(value => !value) }} disabled={outline.length === 0} style={{ ...smallButton, color: outline.length === 0 ? LABEL_3 : LABEL_2 }} className="dov-btn" title="文档目录">
          ☰
        </button>
        <button onClick={() => { goToPage(currentPage - 1) }} disabled={currentPage <= 1} style={smallButton} className="dov-btn" title="上一页">↑</button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          <input
            value={jumpDraft}
            onChange={event => { setJumpDraft(event.target.value.replace(/\D/g, '')) }}
            onKeyDown={event => { if (event.key === 'Enter') { goToPage(Number.parseInt(jumpDraft, 10) || 1); setJumpDraft('') } }}
            placeholder={String(currentPage)}
            style={{ ...input, width: 40, padding: '2px 5px', textAlign: 'center', fontSize: 12 }}
            className="dov-input"
          />
          / {String(pageCount)}
        </span>
        <button onClick={() => { goToPage(currentPage + 1) }} disabled={currentPage >= pageCount} style={smallButton} className="dov-btn" title="下一页">↓</button>
        <span style={{ width: 1, height: 16, background: BORDER }} />
        <button onClick={() => { zoomStep(-1) }} style={smallButton} className="dov-btn" title="缩小">−</button>
        <button
          onClick={() => { setZoom(current => current === 'fit-width' ? 1 : 'fit-width') }}
          style={{ ...smallButton, minWidth: 58 }}
          className="dov-btn"
          title="点击切换 100% / 适应宽度"
        >
          {zoom === 'fit-width' ? '适应宽度' : `${String(Math.round((zoom as number) * 100))}%`}
        </button>
        <button onClick={() => { zoomStep(1) }} style={smallButton} className="dov-btn" title="放大">＋</button>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input
            value={searchDraft}
            onChange={event => { setSearchDraft(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') void runSearch(searchDraft) }}
            placeholder="全文搜索…"
            style={{ ...input, width: 120, padding: '2px 7px', fontSize: 12 }}
            className="dov-input"
          />
          {searchState !== undefined && searchState.total > 0 && (
            <span style={{ fontSize: 11, color: LABEL_3, whiteSpace: 'nowrap' }}>
              {String(searchState.index + 1)}/{String(searchState.total)} 页
            </span>
          )}
          {searchState !== undefined && searchState.total === 0 && (
            <span style={{ fontSize: 11, color: LABEL_3, whiteSpace: 'nowrap' }}>无结果</span>
          )}
          <button onClick={() => { stepSearch(-1) }} disabled={searchState === undefined || searchState.total === 0} style={smallButton} className="dov-btn" title="上一个">‹</button>
          <button onClick={() => { stepSearch(1) }} disabled={searchState === undefined || searchState.total === 0} style={smallButton} className="dov-btn" title="下一个">›</button>
        </span>
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {outlineOpen && outline.length > 0 && (
          <div style={{ width: 180, flex: 'none', overflowY: 'auto', borderRight: `1px solid ${BORDER}`, padding: '6px 4px', fontSize: 12 }} className="dov-list">
            {outline.map((entry, index) => (
              <button
                key={`${String(index)}-${entry.title}`}
                onClick={() => { goToPage(entry.pageIndex + 1) }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '3px 6px',
                  paddingLeft: 6 + entry.depth * 12, border: 'none', background: 'transparent',
                  color: 'inherit', cursor: 'pointer', borderRadius: 5, fontSize: 12,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
                className="dov-row-item"
                title={entry.title}
              >
                {entry.title}
              </button>
            ))}
          </div>
        )}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={onWheel}
          style={{ flex: 1, overflow: 'auto', padding: '10px 0', minHeight: 0 }}
          className="dov-pdf-scroll dov-list"
        >
          {pagePlaceholders.map(pageNumber => (
            <div
              key={pageNumber}
              data-page={pageNumber}
              ref={element => {
                if (element === null) pageRefs.current.delete(pageNumber)
                else pageRefs.current.set(pageNumber, element)
              }}
              className="dov-pdf-page"
              style={{ width: zoom === 'fit-width' ? 'calc(100% - 20px)' : `${String(Math.round(612 * (zoom as number)))}px` }}
            />
          ))}
        </div>
      </div>
      <div style={{ ...row, padding: '4px 10px', borderTop: `1px solid ${BORDER}`, fontSize: 11, color: LABEL_3, flex: 'none', justifyContent: 'space-between' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <span>Ctrl+滚轮缩放</span>
      </div>
    </div>
  )
}
