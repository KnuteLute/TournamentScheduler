import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/api/client'
import type { Session } from '../src/api/types'
import AuthView from '../src/views/AuthView.vue'
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
    displayName: 'Ada gjest',
    collisionNames: ['Ada'],
  }],
}

let unmount = () => {}

afterEach(() => {
  unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function renderClaimForm() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useSessionStore()
  session.apply(pendingSession)
  session.pendingClaim = claim

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/auth', component: AuthView }, { path: '/', component: AuthView }],
  })
  const app = createApp(AuthView)
  app.use(pinia)
  app.use(router)
  await router.push('/auth')
  await router.isReady()
  const root = document.createElement('div')
  document.body.append(root)
  app.mount(root)
  unmount = () => app.unmount()
  return root
}

describe('resuming guest conflict resolution', () => {
  it('renders pending collision details restored from the session', async () => {
    const root = await renderClaimForm()

    expect(root.textContent).toContain('Noen navn må avklares')
    expect(root.textContent).toContain('Ada gjest')
    expect(root.textContent).toContain('Ada')
    expect(root.querySelector('input[required]')).not.toBeNull()
  })

  it('submits a resolved name using the latest session ETag', async () => {
    const root = await renderClaimForm()
    vi.spyOn(api, 'pendingGuestClaim').mockResolvedValueOnce({ data: claim, etag: '"session-v9"' })
    const claimMutation = vi.spyOn(api, 'claimGuestData').mockResolvedValueOnce()
    vi.spyOn(api, 'session').mockResolvedValueOnce({
      data: { ...pendingSession, pendingGuestClaim: false }, etag: '"session-v10"',
    })

    const input = root.querySelector('input[required]') as HTMLInputElement
    input.value = 'Ada fra gjest'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve()
      await nextTick()
    }

    expect(claimMutation).toHaveBeenCalledWith([{
      resourceType: 'player', guestResourceId: 'guest-player-1', newName: 'Ada fra gjest',
    }], '"session-v9"')
    expect(root.textContent).not.toContain('Noen navn må avklares')
  })
})
