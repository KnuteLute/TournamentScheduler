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

const guestSession: Session = {
  ...pendingSession,
  kind: 'guest',
  account: null,
  pendingGuestClaim: false,
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

async function renderLoginForm() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useSessionStore()
  session.apply(guestSession)

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

  it('allows short legacy login passwords while requiring 12 characters for registration', async () => {
    const root = await renderLoginForm()
    const password = root.querySelector('input[type="password"]') as HTMLInputElement
    expect(password.minLength).toBe(1)

    root.querySelector('.switch-auth')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(password.minLength).toBe(12)

    password.value = 'short'
    password.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect((root.querySelector('form') as HTMLFormElement).checkValidity()).toBe(false)
  })

  it('allows a short password on login and applies the 72-byte UTF-8 limit to both flows', async () => {
    const root = await renderLoginForm()
    const username = root.querySelector('input[autocomplete="username"]') as HTMLInputElement
    const password = root.querySelector('input[type="password"]') as HTMLInputElement
    username.value = 'legacy-user'
    username.dispatchEvent(new Event('input', { bubbles: true }))
    password.value = 'x'
    password.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    const login = vi.spyOn(api, 'login').mockResolvedValueOnce({
      data: {
        session: guestSession,
        transfer: { status: 'none', playersTransferred: 0, teamsTransferred: 0, tournamentsTransferred: 0, conflicts: [] },
      },
      etag: null,
    })
    root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve()
      await nextTick()
    }
    expect(login).toHaveBeenCalledWith('legacy-user', 'x')

    root.querySelector('.switch-auth')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    const register = vi.spyOn(api, 'register')
    password.value = '😀'.repeat(6)
    password.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(root.textContent).toContain('minst 12 tegn ved registrering')
    expect(register).not.toHaveBeenCalled()

    password.value = '😀'.repeat(19)
    password.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()

    expect(root.textContent).toContain('maksimalt 72 byte i UTF-8')
    expect(register).not.toHaveBeenCalled()
    expect(password.maxLength).toBe(72)
  })
})
