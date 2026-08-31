/**
 * Local LaTeX compilation for one mirror via `latexmk`. Overleaf projects are
 * plain LaTeX sources, so a local TeX distribution (TeX Live / MiKTeX) can
 * build them without round-tripping through the website; the produced PDF sits
 * next to the entry .tex and opens in the tab's own viewer.
 * @module dsh-better-overleaf/compile
 */
import { spawn } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { OverleafCompileResult } from './types.ts'

/** Build timeout; huge theses still finish far below this. */
const COMPILE_TIMEOUT_MS = 10 * 60_000

/** Log tail kept for diagnostics. */
const LOG_TAIL_BYTES = 4000

/** Whether `latexmk` is runnable on this machine (cached after first probe). */
let latexmkAvailable: boolean | undefined

/** Probe for latexmk once per process; TeX installs do not appear mid-run. */
export async function hasLatexmk(): Promise<boolean> {
  latexmkAvailable ??= await new Promise<boolean>((resolve) => {
    const child = spawn('latexmk', ['--version'], { stdio: 'ignore', windowsHide: true })
    child.once('error', () => { resolve(false) })
    child.once('close', code => { resolve(code === 0) })
  })
  return latexmkAvailable
}

/**
 * Pick the entry .tex of one mirror: `main.tex` first, then the document with
 * a `\documentclass` line, then any other top-level .tex.
 */
export async function pickEntryTex(mirrorPath: string): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(mirrorPath)
  } catch {
    return undefined
  }
  const texFiles = entries.filter(name => name.toLowerCase().endsWith('.tex'))
  if (texFiles.includes('main.tex')) return 'main.tex'
  for (const candidate of texFiles) {
    try {
      const { readFile } = await import('node:fs/promises')
      const head = (await readFile(join(mirrorPath, candidate), 'utf8')).slice(0, 4000)
      if (/\\documentclass\b/.test(head)) return candidate
    } catch {
      // Unreadable candidate; keep scanning.
    }
  }
  return texFiles[0]
}

/** Run latexmk over one entry file, returning the full diagnostics tail. */
async function runLatexmk(
  mirrorPath: string,
  entryFile: string,
  signal: AbortSignal | undefined,
): Promise<{ exitCode: number | null; logTail: string; durationMs: number }> {
  const startedAt = Date.now()
  return await new Promise((resolve, reject) => {
    const child = spawn('latexmk', [
      '-pdf', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', entryFile,
    ], { cwd: mirrorPath, windowsHide: true })
    let output = ''
    const capture = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (output.length > LOG_TAIL_BYTES * 2) output = output.slice(-LOG_TAIL_BYTES * 2)
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    const abort = (): void => { child.kill('SIGTERM') }
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { child.kill('SIGTERM') }, COMPILE_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve({
        exitCode: code,
        logTail: output.slice(-LOG_TAIL_BYTES),
        durationMs: Date.now() - startedAt,
      })
    })
  })
}

/**
 * Compile one mirror's entry .tex into a PDF next to it. Throws when latexmk
 * is absent; build failures return `ok: false` with the log tail instead.
 */
export async function compileMirror(
  mirrorPath: string,
  options: { signal?: AbortSignal } = {},
): Promise<OverleafCompileResult> {
  if (!(await hasLatexmk())) {
    throw new Error('overleaf: 未检测到 latexmk；请安装 TeX Live 或 MiKTeX 后重试')
  }
  const entryFile = await pickEntryTex(mirrorPath)
  if (entryFile === undefined) {
    throw new Error('overleaf: 镜像目录里没有找到 .tex 入口文件')
  }
  const { exitCode, logTail, durationMs } = await runLatexmk(mirrorPath, entryFile, options.signal)
  const pdfPath = join(mirrorPath, entryFile.replace(/\.tex$/i, '.pdf'))
  let ok = exitCode === 0
  if (ok) {
    await access(pdfPath).catch(() => { ok = false })
  }
  return {
    ok,
    ...(ok ? { pdfPath } : {}),
    entryFile,
    exitCode,
    logTail,
    durationMs,
  }
}
