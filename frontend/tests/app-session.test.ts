import { createApp, defineComponent, h, nextTick, onMounted, onUnmounted } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/api/client'
import type { Session } from '../src/api/types'
import { useSessionStore } from '../src/stores/session'
import App from '../src/App.vue'

function makeSession(kind: 'authenticated' | 'guest', csrfToken: string, pendingGuestClaim = false): Session {
  return {
    kind,
    account: kind === 'authenticated' ? { id: 'account-a', username: 'owner-a' } : null,
    csrfToken,
    expiresAt: '2027-01-01T00:00:00Z',
    pendingGuestClaim,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

let dispose = () => {}

afterEach(() => {
  dispose()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function mountApp() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useSessionStore()
  const mounts: string[] = []
  const unmounts: string[] = []
  const OwnerCacheView = defineComponent({
    setup() {
      const ownerCache = store.session?.account?.id ?? 'guest'
      onMounted(() => mounts.push(ownerCache))
      onUnmounted(() => unmounts.push(ownerCache))
      return () => h('div', { class: 'owner-cache' }, `Cache: ${ownerCache}`)
    },
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: OwnerCacheView }] })
  const app = createApp(App)
  app.use(pinia)
  app.use(router)
  await router.push('/')
  await router.isReady()
  const root = document.createElement('div')
  document.body.append(root)
  app.mount(root)
  dispose = () => app.unmount()
  return { root, store, mounts, unmounts }
}

describe('application session boundaries', () => {
  it('unmounts cached owner views immediately on logout and remounts for the new guest session', async () => {
    const accountSession = makeSession('authenticated', 'account-csrf')
    const guestSession = makeSession('guest', 'guest-csrf')
    const logoutRequest = deferred<void>()
    vi.spyOn(api, 'session')
      .mockResolvedValueOnce({ data: accountSession, etag: '"account-session"' })
      .mockResolvedValueOnce({ data: guestSession, etag: '"guest-session"' })
    vi.spyOn(api, 'logout').mockReturnValueOnce(logoutRequest.promise)

    const { root, mounts, unmounts } = await mountApp()
    await flush()
    expect(root.textContent).toContain('Cache: account-a')
    expect(mounts).toEqual(['account-a'])

    root.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(root.textContent).toContain('Logger ut')
    expect(root.textContent).not.toContain('Cache: account-a')
    expect(unmounts).toEqual(['account-a'])

    logoutRequest.resolve()
    await flush()
    expect(root.textContent).toContain('Cache: guest')
    expect(root.textContent).not.toContain('Cache: account-a')
    expect(mounts).toEqual(['account-a', 'guest'])
  })

  it('provides a visible route to resume a pending guest transfer', async () => {
    const accountSession = makeSession('authenticated', 'account-csrf', true)
    vi.spyOn(api, 'session').mockResolvedValueOnce({ data: accountSession, etag: '"account-session"' })
    vi.spyOn(api, 'pendingGuestClaim').mockResolvedValueOnce({
      data: { pending: true, conflicts: [{ entityKind: 'player', resourceId: 'guest-player', displayName: 'Ada', collisionNames: ['Ada'] }] },
      etag: '"account-session"',
    })

    const { root } = await mountApp()
    await flush()

    const claimLink = root.querySelector<HTMLAnchorElement>('.claim-nav-link')
    expect(claimLink?.textContent).toContain('Løs gjesteoverføring')
    expect(claimLink?.getAttribute('href')).toBe('/auth')
  })
})
