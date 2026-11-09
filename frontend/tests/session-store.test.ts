import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/api/client'
import type { Session } from '../src/api/types'
import { useSessionStore } from '../src/stores/session'

const pendingSession: Session = {
  kind: 'authenticated',
  account: { id: 'account-1', username: 'turneringsleder' },
  csrfToken: 'csrf-token-for-test',
  expiresAt: '2027-01-01T00:00:00Z',
  pendingGuestClaim: true,
}

const claim = {
  pending: true as const,
  conflicts: [{
    entityKind: 'player' as const,
    resourceId: 'guest-player-1',
    displayName: 'Ada',
    collisionNames: ['Ada'],
  }],
}

describe('session guest-claim recovery', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('loads pending conflicts and the session ETag when restoring a session after reload', async () => {
    vi.spyOn(api, 'session').mockResolvedValueOnce({ data: pendingSession, etag: '"session-v4"' })
    vi.spyOn(api, 'pendingGuestClaim').mockResolvedValueOnce({ data: claim, etag: '"session-v4"' })
    const store = useSessionStore()

    await store.bootstrap()

    expect(api.pendingGuestClaim).toHaveBeenCalledOnce()
    expect(store.pendingClaim).toEqual(claim)
    expect(store.pendingClaimEtag).toBe('"session-v4"')
    expect(store.bootstrapped).toBe(true)
  })

  it('does not request claim details when the session has no pending claim', async () => {
    vi.spyOn(api, 'session').mockResolvedValueOnce({
      data: { ...pendingSession, pendingGuestClaim: false }, etag: '"session-v5"',
    })
    const pending = vi.spyOn(api, 'pendingGuestClaim')
    const store = useSessionStore()

    await store.bootstrap()

    expect(pending).not.toHaveBeenCalled()
    expect(store.pendingClaim).toBeNull()
    expect(store.pendingClaimEtag).toBeNull()
  })
})
