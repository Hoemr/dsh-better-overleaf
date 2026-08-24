import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { persistentLoginProfileDir } from '../src/login-cdp.ts'

describe('persistent login profile', () => {
  it('resolves to the stable dsh plugin-data path', () => {
    expect(persistentLoginProfileDir()).toBe(
      join(homedir(), '.dsh', 'plugin-data', 'dsh-overleaf', 'browser-profile'),
    )
  })
})
