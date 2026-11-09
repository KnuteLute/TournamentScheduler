import { createApp, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/api/client'
import type { StandingRow, Standings, StandingsView } from '../src/api/types'
import { standingRowKey } from '../src/lib/standing-row-key'
import HistoryView from '../src/views/HistoryView.vue'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function row(name: string, subjectType: StandingRow['subjectType'], playerIds: string[], teamId?: string): StandingRow {
  return {
    rank: 1,
    subjectType,
    name,
    playerIds,
    ...(teamId ? { teamId } : {}),
    matchesPlayed: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    pointDifferential: 0,
  }
}

function table(view: StandingsView, rows: StandingRow[]): Standings {
  return {
    scope: 'overall',
    view,
    tournamentId: null,
    tournamentVersion: null,
    rows,
    calculatedAt: '2026-01-01T00:00:00Z',
  }
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

async function mountHistory() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/history', component: HistoryView }] })
  const app = createApp(HistoryView)
  app.use(router)
  await router.push('/history')
  await router.isReady()
  const root = document.createElement('div')
  document.body.append(root)
  app.mount(root)
  dispose = () => app.unmount()
  return root
}

describe('history standings projection', () => {
  it('ignores stale tab responses and errors after a newer view is selected', async () => {
    const staleTeams = deferred<{ data: Standings; etag: string | null }>()
    const currentPlayers = deferred<{ data: Standings; etag: string | null }>()
    vi.spyOn(api, 'tournaments').mockResolvedValueOnce([])
    let standingsCalls = 0
    vi.spyOn(api, 'standings').mockImplementation((view) => {
      standingsCalls += 1
      if (standingsCalls === 1) return Promise.resolve({ data: table(view, [row('Initial player', 'player', ['p-1'])]), etag: null })
      return view === 'teams' ? staleTeams.promise : currentPlayers.promise
    })

    const root = await mountHistory()
    await flush()
    expect(root.textContent).toContain('Initial player')

    const tabs = root.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(root.textContent).toContain('Oppdaterer tabell')
    expect(root.textContent).not.toContain('Initial player')

    tabs[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    currentPlayers.resolve({ data: table('players', [row('Newest player projection', 'player', ['p-2'])]), etag: null })
    await flush()
    expect(root.textContent).toContain('Newest player projection')

    staleTeams.reject(new Error('stale teams error'))
    await flush()
    expect(root.textContent).toContain('Newest player projection')
    expect(root.textContent).not.toContain('stale teams error')
  })

  it('uses stable team IDs for fixed-team rows sharing the same players', () => {
    const first = standingRowKey(row('Team one', 'fixed_team', ['p-1', 'p-2'], 'team-a'))
    const second = standingRowKey(row('Team two', 'fixed_team', ['p-1', 'p-2'], 'team-b'))

    expect(first).toBe('fixed_team:team-a')
    expect(second).toBe('fixed_team:team-b')
    expect(first).not.toBe(second)
  })
})
