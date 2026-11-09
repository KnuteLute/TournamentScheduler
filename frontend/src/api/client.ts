import type {
  AuthResult, Id, Match, Page, Player, Problem, Schedule, Session,
  Standings, StandingsView, Team, Tournament, TournamentMode,
} from './types'

export class ApiError extends Error {
  readonly status: number
  readonly problem: Problem | null
  readonly retryAfter: string | null

  constructor(status: number, problem: Problem | null, retryAfter: string | null) {
    super(problem?.detail || problem?.title || messageForStatus(status))
    this.name = 'ApiError'
    this.status = status
    this.problem = problem
    this.retryAfter = retryAfter
  }
}

function messageForStatus(status: number): string {
  const messages: Record<number, string> = {
    401: 'Økten er utløpt. Logg inn igjen.',
    403: 'Handlingen ble avvist. Oppdater siden og prøv igjen.',
    404: 'Fant ikke innholdet. Det kan være slettet eller utilgjengelig.',
    409: 'Endringen kolliderer med gjeldende data. Oppdater og prøv igjen.',
    412: 'Dataene er endret siden sist. Vi henter siste versjon — prøv handlingen på nytt.',
    422: 'Noen av opplysningene kunne ikke godtas.',
    428: 'Dataene må oppdateres før endringen kan lagres.',
    429: 'For mange forsøk. Vent litt før du prøver igjen.',
  }
  return messages[status] || 'Noe gikk galt. Prøv igjen senere.'
}

function idempotencyKey(): string {
  return crypto.randomUUID()
}

type RequestOptions = {
  method?: string
  body?: unknown
  contentType?: string
  csrf?: boolean
  optionalCsrf?: boolean
  ifMatch?: string
  idempotent?: boolean
}

export class ApiClient {
  constructor(
    private readonly base = '/api/v1',
    private readonly fetcher: typeof fetch = fetch,
    private readonly csrfToken: () => string | undefined = () => undefined,
  ) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<{ data: T; etag: string | null }> {
    const method = options.method || 'GET'
    const headers = new Headers({ Accept: 'application/json, application/problem+json' })
    if (options.body !== undefined) {
      headers.set('Content-Type', options.contentType || 'application/json')
    }
    const token = this.csrfToken()
    if (options.csrf && token) headers.set('X-CSRF-Token', token)
    if (options.optionalCsrf && token) headers.set('X-CSRF-Token', token)
    if (options.ifMatch) headers.set('If-Match', options.ifMatch)
    if (options.idempotent) headers.set('Idempotency-Key', idempotencyKey())

    const response = await this.fetcher(`${this.base}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    if (!response.ok) {
      let problem: Problem | null = null
      try {
        problem = await response.json() as Problem
      } catch {
        // Keep errors safe and useful even if a proxy returned a non-JSON body.
      }
      throw new ApiError(response.status, problem, response.headers.get('Retry-After'))
    }
    const data = response.status === 204 ? undefined : await response.json() as T
    return { data: data as T, etag: response.headers.get('ETag') }
  }

  async session(): Promise<{ data: Session; etag: string | null }> {
    try {
      return await this.request<Session>('/session')
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error
      // Guest bootstrap is intentionally the only write without an idempotency key.
      await this.request<Session>('/sessions', { method: 'POST' })
      return this.request<Session>('/session')
    }
  }

  login(username: string, password: string): Promise<{ data: AuthResult; etag: string | null }> {
    return this.request('/auth/login', { method: 'POST', body: { username, password }, optionalCsrf: true, idempotent: true })
  }

  register(username: string, password: string): Promise<{ data: AuthResult; etag: string | null }> {
    return this.request('/auth/register', { method: 'POST', body: { username, password }, optionalCsrf: true, idempotent: true })
  }

  async logout(): Promise<void> {
    await this.request<void>('/auth/logout', { method: 'POST', csrf: true, idempotent: true })
  }

  async claimGuestData(
    resolutions: { resourceType: 'player' | 'team'; guestResourceId: Id; newName: string }[],
  ): Promise<void> {
    const current = await this.request<Session>('/session')
    await this.request('/session/claim', {
      method: 'POST', body: { renames: resolutions }, csrf: true,
      ifMatch: current.etag || undefined, idempotent: true,
    })
  }

  async all<T>(path: string): Promise<T[]> {
    const results: T[] = []
    let cursor: string | null = null
    do {
      const query = new URLSearchParams({ limit: '100' })
      if (cursor) query.set('cursor', cursor)
      const page = await this.request<Page<T>>(`${path}?${query}`)
      results.push(...page.data.items)
      cursor = page.data.nextCursor
    } while (cursor)
    return results
  }

  players(): Promise<Player[]> { return this.all('/players') }
  teams(): Promise<Team[]> { return this.all('/teams') }
  tournaments(): Promise<Tournament[]> { return this.all('/tournaments') }
  matches(tournamentId: Id): Promise<Match[]> { return this.all(`/tournaments/${encodeURIComponent(tournamentId)}/matches`) }
  player(id: Id) { return this.request<Player>(`/players/${encodeURIComponent(id)}`) }
  team(id: Id) { return this.request<Team>(`/teams/${encodeURIComponent(id)}`) }
  tournament(id: Id) { return this.request<Tournament>(`/tournaments/${encodeURIComponent(id)}`) }
  schedule(id: Id) { return this.request<Schedule>(`/tournaments/${encodeURIComponent(id)}/schedule`) }

  createPlayer(name: string) {
    return this.request<Player>('/players', { method: 'POST', body: { name }, csrf: true, idempotent: true })
  }

  async updatePlayer(id: Id, name: string) {
    const latest = await this.player(id)
    return this.request<Player>(`/players/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: { name }, contentType: 'application/merge-patch+json',
      csrf: true, ifMatch: latest.etag || undefined, idempotent: true,
    })
  }

  async deletePlayer(id: Id) {
    const latest = await this.player(id)
    await this.request<void>(`/players/${encodeURIComponent(id)}`, {
      method: 'DELETE', csrf: true, ifMatch: latest.etag || undefined, idempotent: true,
    })
  }

  createTeam(name: string, playerIds: Id[]) {
    return this.request<Team>('/teams', { method: 'POST', body: { name, playerIds }, csrf: true, idempotent: true })
  }

  async updateTeam(id: Id, patch: { name?: string; playerIds?: Id[] }) {
    const latest = await this.team(id)
    return this.request<Team>(`/teams/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: patch, contentType: 'application/merge-patch+json',
      csrf: true, ifMatch: latest.etag || undefined, idempotent: true,
    })
  }

  async deleteTeam(id: Id) {
    const latest = await this.team(id)
    await this.request<void>(`/teams/${encodeURIComponent(id)}`, {
      method: 'DELETE', csrf: true, ifMatch: latest.etag || undefined, idempotent: true,
    })
  }

  createTournament(input: { name: string; mode: TournamentMode; playerIds: Id[] }) {
    return this.request<Tournament>('/tournaments', { method: 'POST', body: input, csrf: true, idempotent: true })
  }

  async tournamentAction(id: Id, action: 'start' | 'pause' | 'resume' | 'finish' | 'cancel') {
    const latest = await this.tournament(id)
    return this.request<Tournament>(`/tournaments/${encodeURIComponent(id)}/${action}`, {
      method: 'POST', csrf: true, ifMatch: latest.etag || undefined, idempotent: true,
    })
  }

  async setAvailability(id: Id, pausedPlayerIds: Id[]) {
    const latest = await this.tournament(id)
    return this.request<Tournament>(`/tournaments/${encodeURIComponent(id)}/availability`, {
      method: 'PATCH', body: { pausedPlayerIds }, csrf: true,
      ifMatch: latest.etag || undefined, idempotent: true,
    })
  }

  async matchAction(tournamentId: Id, matchId: Id, action: 'start' | 'pause' | 'resume' | 'skip') {
    const latest = await this.tournament(tournamentId)
    return this.request<Match>(`/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(matchId)}/${action}`, {
      method: 'POST', csrf: true, ifMatch: latest.etag || undefined, idempotent: true,
    })
  }

  async recordResult(tournamentId: Id, matchId: Id, scores: [number, number]) {
    const latest = await this.tournament(tournamentId)
    return this.request<{ match: Match; tournamentVersion: number }>(
      `/tournaments/${encodeURIComponent(tournamentId)}/matches/${encodeURIComponent(matchId)}/result`,
      { method: 'POST', body: { scores }, csrf: true, ifMatch: latest.etag || undefined, idempotent: true },
    )
  }

  async standings(view: StandingsView, tournamentId?: Id) {
    const scope = tournamentId
      ? `/tournaments/${encodeURIComponent(tournamentId)}/standings`
      : '/standings'
    return this.request<Standings>(`${scope}?view=${view}`)
  }
}

let activeCsrfToken: string | undefined
export function setApiCsrfToken(token?: string) { activeCsrfToken = token }
export const api = new ApiClient('/api/v1', fetch, () => activeCsrfToken)
