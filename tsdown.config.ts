/**
 * Build dsh-better-overleaf as a dual-face DSH plugin:
 * - host pass: ESM `lib/index.js` loaded by the dsh web host;
 * - client pass: CJS `lib/client.js` closure registered through
 *   `window.__ModuleLoader__.load({ id, factory })`.
 *
 * The repository-independent preset mirrors the harness client-bundle wire
 * contract without importing the harness workspace. CSS Modules are not used
 * yet; add a lightningcss virtual-loader mirror when the tab grows styles.
 */
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'tsdown'

// `?raw` suffix inlining (the pdf.js worker source ships as a string so the
// single-file client bundle can blob it into a worker without extra assets).
// Rolldown's built-in ?raw mishandles Windows paths, hence this explicit pass.
function rawLoader(): Plugin {
  return {
    name: 'dsh-overleaf:raw-loader',
    async resolveId(source, importer, options) {
      if (!source.endsWith('?raw')) return null
      const resolved = await this.resolve(source.slice(0, -4), importer, { ...options, skipSelf: true })
      return resolved === null ? null : `${resolved.id}?raw`
    },
    load(id) {
      if (!id.endsWith('?raw')) return null
      return `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`
    },
  }
}

// ID must be the npm package name (package.json `name`) — the DSH plugin
// contract enforces it in THREE places at once:
//   1. host bundle identity: node_modules/<name> must be a package named <name>;
//   2. loader row name (cordis.patch.yml `name:`);
//   3. client bundle registration id (the client module system looks the
//      factory up by entry id == package name).
// Deriving it here makes renames impossible to forget; never hardcode.
const { name: ID } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string }

const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime'] as const

const CLIENT_DEFINES = {
  'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
}

export default defineConfig([
  {
    name: ID,
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
      fixedExtension: false,
    target: 'es2024',
    dts: false,
    clean: false,
  },
  {
    name: `${ID}/client`,
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: CLIENT_DEFINES,
    plugins: [rawLoader()],
    noExternal: id => !CLIENT_EXTERNALS.includes(id as (typeof CLIENT_EXTERNALS)[number]),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
