/**
 * One-shot Overleaf endpoint diagnostic. Reads the locally stored cookie,
 * probes candidate project-list endpoints, and prints ONLY status codes,
 * final URLs, sizes, and boolean markers — never credential values.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.USERPROFILE ?? process.env.HOME
const raw = readFileSync(join(home, '.dsh', '.credentials.yaml'), 'utf8')
// YAML shape: `OVERLEAF_COOKIE: <single-line value>` (value never printed).
const line = raw.split(/\r?\n/).find(l => l.trim().startsWith('OVERLEAF_COOKIE:'))
if (line === undefined) {
  console.log('OVERLEAF_COOKIE key not found in credentials file')
  process.exit(1)
}
const cookie = line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '')
console.log('cookie present:', cookie.length > 0, '| length:', cookie.length)
console.log('has overleaf_session2 pair:', /(^|;\s*)overleaf_session2=[^;\s]/.test(cookie))

async function probe(label, path) {
  try {
    const res = await fetch(`https://www.overleaf.com${path}`, {
      headers: { cookie, accept: 'application/json', 'x-requested-with': 'XMLHttpRequest', referer: 'https://www.overleaf.com/project' },
      redirect: 'manual',
    })
    const location = res.headers.get('location') ?? ''
    const body = res.status === 200 ? await res.text() : ''
    const blobTag = body.match(/<meta\b[^>]*ol-prefetchedProjectsBlob[^>]*>/i)
    const blob = blobTag !== null ? blobTag[0].match(/content=["']([^"']*)["']/i) : null
    let projectCount = -1
    let firstName = ''
    if (blob !== null) {
      try {
        const parsed = JSON.parse(blob[1].replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&'))
        if (parsed !== null && typeof parsed === 'object') {
          console.log(`  blob top-level keys: ${Object.keys(parsed).join(', ')}`)
          for (const [key, value] of Object.entries(parsed)) {
            if (Array.isArray(value)) {
              projectCount = value.length
              firstName = typeof value[0]?.name === 'string' ? value[0].name : ''
              console.log(`  blob array "${key}": len=${value.length} firstKeys=${value[0] && typeof value[0] === 'object' ? Object.keys(value[0]).slice(0, 12).join(',') : typeof value[0]} first="${firstName}"`)
            }
          }
        }
      } catch (error) { console.log(`  blob parse error: ${error.message}`) }
    }
    const markers = {
      jsonArray: body.trim().startsWith('['),
      hasProjectLinks: /\/project\/[0-9a-f]{24}/i.test(body),
      looksLikeLogin: /log[- ]?in|ol-login|sign in/i.test(body.slice(0, 4000)),
    }
    console.log(`${label} ${path} -> ${res.status} loc=${location || '-'} len=${body.length} ${JSON.stringify(markers)}`)
  } catch (error) {
    console.log(`${label} ${path} -> ERROR ${error.message}`)
  }
}

await probe('[real]   ', '/api/project')
await probe('[real]   ', '/api/projects')
await probe('[real]   ', '/api/v2/projects')
await probe('[real]   ', '/project')

// Auth-failure baseline with an invalid session for comparison.
await probe('[broken] ', '/api/project')
await probe('[broken] ', '/project')
