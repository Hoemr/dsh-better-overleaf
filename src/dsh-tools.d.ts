/**
 * Bundler raw-text import (`?raw`) for inlining the pdf.js worker source.
 *
 * `@deepseek-ai/dsh-tools` used to be shipped only inside the Desktop app, so
 * this file also carried a hand-written ambient declaration for it. The package
 * is published on npm from 0.2.0 on and is a devDependency now, so the real
 * declarations are authoritative and the stub is gone.
 */
declare module '*?raw' {
  const content: string
  export default content
}
