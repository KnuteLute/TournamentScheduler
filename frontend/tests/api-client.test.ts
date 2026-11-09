import { describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from '../src/api/client'

function jsonResponse(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

describe('same-origin API client', () => {
  it('invokes the native global fetch with its required global receiver', async () => {
    const fetcher = vi.fn<typeof fetch>(function (this: unknown) {
      expect(this).toBe(globalThis)
      return Promise.resolve(jsonResponse({ kind: 'guest' }))
    })
    vi.stubGlobal('fetch', fetcher)

    try {
      const client = new ApiClient('/api/v1', fetcher)
      await client.request('/session')
      expect(fetcher).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('sends CSRF and a fresh idempotency key for creates without an If-Match', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: 'p-1', name: 'Ada' }, 201))
    const client = new ApiClient('/api/v1', fetcher, () => 'csrf-token-value')

    await client.createPlayer('Ada')

    const [url, init] = fetcher.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(url).toBe('/api/v1/players')
    expect(init?.credentials).toBe('same-origin')
    expect(headers.get('X-CSRF-Token')).toBe('csrf-token-value')
    expect(headers.get('Idempotency-Key')).toBeTruthy()
    expect(headers.get('If-Match')).toBeNull()
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Ada' })
  })

  it('fetches a current entity ETag before patching it', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: 'p/1', name: 'Ada' }, 200, { ETag: '"player-v3"' }))
      .mockResolvedValueOnce(jsonResponse({ id: 'p/1', name: 'Ada Lovelace' }, 200, { ETag: '"player-v4"' }))
    const client = new ApiClient('/api/v1', fetcher, () => 'csrf-token-value')

    await client.updatePlayer('p/1', 'Ada Lovelace')

    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/players/p%2F1')
    expect(fetcher.mock.calls[0][1]?.cache).toBe('no-store')
    const headers = new Headers(fetcher.mock.calls[1][1]?.headers)
    expect(headers.get('If-Match')).toBe('"player-v3"')
    expect(headers.get('Content-Type')).toBe('application/merge-patch+json')
    expect(headers.get('Idempotency-Key')).toBeTruthy()
  })

  it('uses the parent tournament ETag for match result mutations', async () => {
    const tournament = { id: 't-4', status: 'active' }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(tournament, 200, { ETag: '"tournament-v8"' }))
      .mockResolvedValueOnce(jsonResponse({ match: { id: 'm-1' }, tournamentVersion: 9 }, 200))
    const client = new ApiClient('/api/v1', fetcher, () => 'csrf-token-value')

    await client.recordResult('t-4', 'm-1', [11, 8])

    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/tournaments/t-4')
    const headers = new Headers(fetcher.mock.calls[1][1]?.headers)
    expect(headers.get('If-Match')).toBe('"tournament-v8"')
    expect(headers.get('X-CSRF-Token')).toBe('csrf-token-value')
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ scores: [11, 8] })
  })

  it('loads pending guest conflicts and submits the rename with that session ETag', async () => {
    const conflicts = [{
      entityKind: 'player' as const,
      resourceId: 'guest-player-1',
      displayName: 'Ada',
      collisionNames: ['Ada'],
    }]
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ pending: true, conflicts }, 200, { ETag: '"session-v12"' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    const client = new ApiClient('/api/v1', fetcher, () => 'csrf-token-value')

    const pending = await client.pendingGuestClaim()
    await client.claimGuestData([{
      resourceType: 'player', guestResourceId: 'guest-player-1', newName: 'Ada fra gjest',
    }], pending.etag!)

    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/session/claim')
    expect(pending.data.conflicts).toEqual(conflicts)
    const [postUrl, postInit] = fetcher.mock.calls[1]
    const headers = new Headers(postInit?.headers)
    expect(postUrl).toBe('/api/v1/session/claim')
    expect(postInit?.method).toBe('POST')
    expect(headers.get('If-Match')).toBe('"session-v12"')
    expect(headers.get('X-CSRF-Token')).toBe('csrf-token-value')
    expect(headers.get('Idempotency-Key')).toBeTruthy()
    expect(JSON.parse(String(postInit?.body))).toEqual({ renames: [{
      resourceType: 'player', guestResourceId: 'guest-player-1', newName: 'Ada fra gjest',
    }] })
  })

  it('parses safe RFC problem details and retry guidance', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      type: 'about:blank', title: 'For mange forsøk', status: 429, detail: 'Prøv igjen senere.',
    }, 429, { 'Retry-After': '30' }))
    const client = new ApiClient('/api/v1', fetcher)

    await expect(client.request('/players')).rejects.toMatchObject({
      name: 'ApiError', status: 429, retryAfter: '30',
    } satisfies Partial<ApiError>)
  })

  it('creates a guest session only after a 401 and never adds an idempotency key to bootstrap', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ status: 401 }, 401))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'created' }, 201))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'current' }, 200, { ETag: '"session-v1"' }))
    const client = new ApiClient('/api/v1', fetcher)

    const current = await client.session()

    expect(current.data.csrfToken).toBe('current')
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/session', '/api/v1/sessions', '/api/v1/session',
    ])
    const bootstrapHeaders = new Headers(fetcher.mock.calls[1][1]?.headers)
    expect(fetcher.mock.calls[1][1]?.method).toBe('POST')
    expect(bootstrapHeaders.has('Idempotency-Key')).toBe(false)
  })

  it.each([
    [401, 'Økten er utløpt. Logg inn igjen.'],
    [403, 'Handlingen ble avvist. Oppdater siden og prøv igjen.'],
    [409, 'Endringen kolliderer med gjeldende data. Oppdater og prøv igjen.'],
    [412, 'Dataene er endret siden sist. Vi henter siste versjon — prøv handlingen på nytt.'],
    [422, 'Noen av opplysningene kunne ikke godtas.'],
    [429, 'For mange forsøk. Vent litt før du prøver igjen.'],
  ])('provides safe Norwegian guidance for HTTP %i', async (status, message) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status }, status))
    const client = new ApiClient('/api/v1', fetcher)
    await expect(client.request('/resource')).rejects.toMatchObject({ status, message })
  })
})
