import { createApp, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HomeView from '../src/views/HomeView.vue'
import { api } from '../src/api/client'

const mounted: { unmount?: () => void } = {}

async function renderHome() {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(HomeView)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: HomeView }] })
  app.use(router)
  await router.push('/')
  await router.isReady()
  mounted.unmount = app.mount(root) && (() => app.unmount())
  return root
}

afterEach(() => mounted.unmount?.())

describe('home screen', () => {
  it('shows a useful empty state when the owner has no tournaments', async () => {
    vi.spyOn(api, 'tournaments').mockResolvedValueOnce([])
    const root = await renderHome()
    await Promise.resolve()
    await nextTick()
    expect(root.textContent).toContain('Her starter moroa')
    expect(root.textContent).toContain('Lag din første turnering')
  })

  it('renders persisted tournament state from the API', async () => {
    vi.spyOn(api, 'tournaments').mockResolvedValueOnce([{
      id: 't-1', name: 'Klubbkveld', mode: '2v2_rotating', status: 'active', participants: [],
      pausedPlayerIds: [], version: 1, seed: 'seed', generatorVersion: '1',
      createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:00:00Z',
    }])
    const root = await renderHome()
    await Promise.resolve()
    await nextTick()
    expect(root.textContent).toContain('Klubbkveld')
    expect(root.textContent).toContain('Pågår')
    expect(root.textContent).toContain('2 mot 2 · roterende lag')
  })
})
