/**
 * Overleaf credential references. Values never pass through plugin config or
 * routes; the host resolves and stores them through `ctx.credentials`.
 */
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/** Overleaf cookie captured by the direct-CDP login (API transport). */
export const OVERLEAF_COOKIE: CredentialRef = credentialRef('OVERLEAF_COOKIE')

/** Git-bridge credential for `https://git.overleaf.com/<projectId>` (git transport). */
export const OVERLEAF_GIT_TOKEN: CredentialRef = credentialRef('OVERLEAF_GIT_TOKEN')
