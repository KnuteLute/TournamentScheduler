<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ApiError, api } from '@/api/client'
import type { Match, Schedule, Standings, StandingsView, Tournament } from '@/api/types'
import { errorMessage, friendlyMode, friendlyStatus } from '@/lib/errors'

const props = defineProps<{ id: string }>()
const tournament = ref<Tournament | null>(null)
const matches = ref<Match[]>([])
const schedule = ref<Schedule | null>(null)
const standings = ref<Standings | null>(null)
const standingsView = ref<StandingsView>('players')
const scores = ref<Record<string, [string, string]>>({})
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const success = ref('')
const matchMap = computed(() => new Map(matches.value.map((match) => [match.id, match])))
const canManage = computed(() => tournament.value?.status === 'active' || tournament.value?.status === 'paused')

async function load() {
  error.value = ''
  try {
    const current = await api.tournament(props.id)
    tournament.value = current.data
    const [matchRows, plan, table] = await Promise.all([
      api.matches(props.id),
      current.data.status === 'draft' ? Promise.resolve(null) : api.schedule(props.id).then((result) => result.data),
      current.data.status === 'draft' ? Promise.resolve(null) : api.standings(standingsView.value, props.id).then((result) => result.data),
    ])
    matches.value = matchRows
    schedule.value = plan
    standings.value = table
    for (const match of matchRows) scores.value[match.id] = [String(match.sides[0].score ?? ''), String(match.sides[1].score ?? '')]
  } catch (cause) { error.value = errorMessage(cause) }
  finally { loading.value = false }
}
onMounted(load)

async function run(action: () => Promise<unknown>, message: string) {
  busy.value = true; error.value = ''; success.value = ''
  try { await action(); success.value = message; await load() }
  catch (cause) {
    error.value = errorMessage(cause)
    if (cause instanceof ApiError && cause.status === 412) await load()
  } finally { busy.value = false }
}

function doTournamentAction(action: 'start' | 'pause' | 'resume' | 'finish' | 'cancel') {
  const labels = { start: 'Turneringen er startet.', pause: 'Turneringen er satt på pause.', resume: 'Turneringen er i gang igjen.', finish: 'Turneringen er avsluttet.', cancel: 'Turneringen er avlyst.' }
  if ((action === 'finish' || action === 'cancel') && !window.confirm(action === 'finish' ? 'Avslutte turneringen nå? Uspilte kamper får ikke resultat.' : 'Avlyse turneringen? Registrerte resultater beholdes.')) return
  void run(() => api.tournamentAction(props.id, action), labels[action])
}

function toggleAvailability(playerId: string) {
  if (!tournament.value) return
  const paused = new Set(tournament.value.pausedPlayerIds)
  if (paused.has(playerId)) paused.delete(playerId)
  else paused.add(playerId)
  void run(() => api.setAvailability(props.id, [...paused]), 'Spillertilgjengeligheten er oppdatert.')
}

function matchAction(match: Match, action: 'start' | 'pause' | 'resume' | 'skip') {
  if (action === 'skip' && !window.confirm('Hoppe over denne kampen? Den får ikke resultat eller poeng.')) return
  const messages = { start: 'Kampen er startet.', pause: 'Kampen er satt på pause.', resume: 'Kampen er i gang igjen.', skip: 'Kampen er hoppet over.' }
  void run(() => api.matchAction(props.id, match.id, action), messages[action])
}

function submitScore(match: Match) {
  const values = scores.value[match.id] || ['', '']
  void run(() => api.recordResult(props.id, match.id, [Number(values[0]), Number(values[1])]), 'Resultatet er lagret og tabellen oppdatert.')
}

async function changeStandings(view: StandingsView) {
  standingsView.value = view
  if (!tournament.value || tournament.value.status === 'draft') return
  try { standings.value = (await api.standings(view, props.id)).data }
  catch (cause) { error.value = errorMessage(cause) }
}

function participantNames(match: Match) {
  return match.sides.map((side) => side.players.map((player) => player.name).join(' & ') || side.name)
}
</script>

<template>
  <div
    v-if="loading"
    class="loading-state"
    role="status"
  >
    Henter turnering …
  </div>
  <template v-else-if="tournament">
    <div class="breadcrumb">
      <RouterLink to="/">Oversikt</RouterLink><span aria-hidden="true">/</span><span>{{ tournament.name }}</span>
    </div>
    <section class="tournament-hero">
      <div>
        <p class="eyebrow">
          {{ friendlyMode(tournament.mode) }}
        </p><h1>{{ tournament.name }}</h1><p class="hero-meta">
          {{ tournament.participants.length }} deltakere <span aria-hidden="true">·</span> Opprettet {{ new Date(tournament.createdAt).toLocaleDateString('nb-NO') }}
        </p>
      </div>
      <div class="hero-status">
        <span
          class="status-pill"
          :class="`status-${tournament.status}`"
        >{{ friendlyStatus(tournament.status) }}</span><span
          v-if="tournament.status === 'active'"
          class="live-dot"
        ><i /> I spill</span>
      </div>
    </section>
    <p
      v-if="error"
      class="notice notice-error"
      role="alert"
    >
      {{ error }}
    </p><p
      v-if="success"
      class="notice notice-success"
      role="status"
    >
      {{ success }}
    </p>

    <section class="content-card action-bar">
      <div>
        <p class="eyebrow">
          TURNERINGSKONTROLL
        </p><strong>{{ tournament.status === 'draft' ? 'Klar når dere er' : tournament.status === 'paused' ? 'Spillet står stille' : tournament.status === 'active' ? 'Hold flyten i gang' : 'Historikken er lagret' }}</strong>
      </div>
      <div class="button-row">
        <button
          v-if="tournament.status === 'draft'"
          class="button button-primary"
          :disabled="busy"
          @click="doTournamentAction('start')"
        >
          Start turneringen <span aria-hidden="true">→</span>
        </button>
        <template v-if="tournament.status === 'active'">
          <button
            class="button button-secondary"
            :disabled="busy"
            @click="doTournamentAction('pause')"
          >
            Ⅱ Pause turnering
          </button><button
            class="button button-quiet"
            :disabled="busy"
            @click="doTournamentAction('finish')"
          >
            Avslutt
          </button><button
            class="button button-quiet danger-action"
            :disabled="busy"
            @click="doTournamentAction('cancel')"
          >
            Avlys
          </button>
        </template>
        <template v-if="tournament.status === 'paused'">
          <button
            class="button button-primary"
            :disabled="busy"
            @click="doTournamentAction('resume')"
          >
            Fortsett turnering
          </button><button
            class="button button-quiet"
            :disabled="busy"
            @click="doTournamentAction('finish')"
          >
            Avslutt
          </button><button
            class="button button-quiet danger-action"
            :disabled="busy"
            @click="doTournamentAction('cancel')"
          >
            Avlys
          </button>
        </template>
      </div>
    </section>

    <div
      v-if="canManage"
      class="content-card availability-card"
    >
      <div class="section-heading compact">
        <div>
          <p class="eyebrow">
            SPILLERSTATUS
          </p><h2>Hvem er klar?</h2>
        </div><span class="helper-text">Pause en spiller uten å fjerne historikken deres.</span>
      </div>
      <div class="availability-list">
        <label
          v-for="person in tournament.participants"
          :key="person.id"
          class="availability-person"
          :class="{ unavailable: tournament.pausedPlayerIds.includes(person.id) }"
        ><input
          type="checkbox"
          :checked="!tournament.pausedPlayerIds.includes(person.id)"
          :disabled="busy"
          @change="toggleAvailability(person.id)"
        ><span>{{ person.name }}</span><small>{{ tournament.pausedPlayerIds.includes(person.id) ? 'På pause' : 'Klar' }}</small></label>
      </div>
      <p
        v-if="tournament.mode === '2v2_rotating' && tournament.participants.length - tournament.pausedPlayerIds.length < 4"
        class="notice notice-warning"
      >
        Fire spillere må være klare før neste roterende kamp kan opprettes.
      </p>
    </div>

    <div class="tournament-columns">
      <section class="content-card schedule-card">
        <div class="section-heading compact">
          <div>
            <p class="eyebrow">
              SPILLEPLAN
            </p><h2>Kampene <span class="count-badge">{{ matches.length }}</span></h2>
          </div><span
            class="schedule-mark"
            aria-hidden="true"
          >↗</span>
        </div>
        <div
          v-if="tournament.status === 'draft'"
          class="empty-state compact-empty"
        >
          <span
            class="empty-icon"
            aria-hidden="true"
          >◷</span><h3>Spilleplanen venter</h3><p>Start turneringen for å la serveren sette opp kampene.</p>
        </div>
        <div
          v-else-if="!schedule?.rounds.length"
          class="empty-state compact-empty"
        >
          <span
            class="empty-icon"
            aria-hidden="true"
          >◷</span><h3>Venter på spillere</h3><p>Ingen nye kamper ennå. I roterende spill trengs fire ledige spillere.</p>
        </div>
        <div
          v-else
          class="round-list"
        >
          <section
            v-for="round in schedule.rounds"
            :key="round.round"
            class="round-block"
          >
            <div class="round-heading">
              <span>RUNDE {{ round.round.toString().padStart(2, '0') }}</span><span class="round-line" /><small>{{ round.matchIds.length }} {{ round.matchIds.length === 1 ? 'kamp' : 'kamper' }}</small>
            </div>
            <article
              v-for="matchId in round.matchIds"
              :key="matchId"
              class="match-card"
            >
              <div class="match-top">
                <span class="match-sequence">KAMP {{ matchMap.get(matchId)?.sequence.toString().padStart(2, '0') || '—' }}</span><span
                  class="status-pill status-match"
                  :class="`match-${matchMap.get(matchId)?.status}`"
                >{{ matchMap.get(matchId) ? ({ scheduled: 'Venter', in_progress: 'Spilles nå', paused: 'Pause', completed: 'Ferdig', skipped: 'Hoppet over' } as Record<string, string>)[matchMap.get(matchId)!.status] : 'Planlagt' }}</span>
              </div>
              <template v-if="matchMap.get(matchId)">
                <div class="match-sides">
                  <div class="match-side">
                    <strong>{{ participantNames(matchMap.get(matchId)!)[0] }}</strong><span
                      v-if="matchMap.get(matchId)!.status === 'completed'"
                      class="match-score"
                    >{{ matchMap.get(matchId)!.sides[0].score }}</span>
                  </div><div class="versus">
                    VS
                  </div><div class="match-side">
                    <strong>{{ participantNames(matchMap.get(matchId)!)[1] }}</strong><span
                      v-if="matchMap.get(matchId)!.status === 'completed'"
                      class="match-score"
                    >{{ matchMap.get(matchId)!.sides[1].score }}</span>
                  </div>
                </div>
                <div
                  v-if="tournament.status === 'active'"
                  class="match-controls"
                >
                  <button
                    v-if="matchMap.get(matchId)!.status === 'scheduled'"
                    class="button button-secondary button-small"
                    :disabled="busy"
                    @click="matchAction(matchMap.get(matchId)!, 'start')"
                  >
                    Start kamp
                  </button>
                  <template v-if="matchMap.get(matchId)!.status === 'in_progress'">
                    <button
                      class="button button-quiet button-small"
                      :disabled="busy"
                      @click="matchAction(matchMap.get(matchId)!, 'pause')"
                    >
                      Ⅱ Pause
                    </button><button
                      class="button button-quiet button-small"
                      :disabled="busy"
                      @click="matchAction(matchMap.get(matchId)!, 'skip')"
                    >
                      Hopp over
                    </button>
                  </template>
                  <button
                    v-if="matchMap.get(matchId)!.status === 'paused'"
                    class="button button-secondary button-small"
                    :disabled="busy"
                    @click="matchAction(matchMap.get(matchId)!, 'resume')"
                  >
                    Fortsett kamp
                  </button>
                  <button
                    v-if="['scheduled', 'paused'].includes(matchMap.get(matchId)!.status)"
                    class="button button-quiet button-small"
                    :disabled="busy"
                    @click="matchAction(matchMap.get(matchId)!, 'skip')"
                  >
                    Hopp over
                  </button>
                </div>
                <form
                  v-if="tournament.status === 'active' && matchMap.get(matchId)!.status === 'in_progress'"
                  class="score-form"
                  @submit.prevent="submitScore(matchMap.get(matchId)!)"
                >
                  <label><span class="sr-only">Poeng {{ participantNames(matchMap.get(matchId)!)[0] }}</span><input
                    v-model="scores[matchId][0]"
                    type="number"
                    min="0"
                    max="1000000"
                    required
                    inputmode="numeric"
                  ></label><span aria-hidden="true">–</span><label><span class="sr-only">Poeng {{ participantNames(matchMap.get(matchId)!)[1] }}</span><input
                    v-model="scores[matchId][1]"
                    type="number"
                    min="0"
                    max="1000000"
                    required
                    inputmode="numeric"
                  ></label><button
                    class="button button-primary button-small"
                    :disabled="busy"
                  >
                    Lagre resultat
                  </button>
                </form>
              </template><p
                v-else
                class="match-waiting"
              >
                {{ tournament.status === 'paused' ? 'Turneringen er satt på pause.' : 'Kampinformasjon oppdateres fra serveren.' }}
              </p>
            </article>
            <div
              v-for="bye in round.byeEvents"
              :key="`${bye.subjectType}:${bye.subjectId}`"
              class="schedule-event"
            >
              <span aria-hidden="true">☼</span>{{ tournament.participants.find((p) => p.id === bye.subjectId)?.name || 'Deltaker' }} har frirunde
            </div>
            <div
              v-for="restId in round.restPlayerIds"
              :key="restId"
              class="schedule-event rest-event"
            >
              <span aria-hidden="true">◌</span>{{ tournament.participants.find((p) => p.id === restId)?.name || 'Spiller' }} hviler denne runden
            </div>
          </section>
        </div>
      </section>

      <section class="content-card standings-card">
        <div class="section-heading compact">
          <div>
            <p class="eyebrow">
              RESULTATENE
            </p><h2>Tabell</h2>
          </div><span
            class="standing-trophy"
            aria-hidden="true"
          >✦</span>
        </div>
        <div
          class="segmented-control"
          role="tablist"
          aria-label="Tabellvisning"
        >
          <button
            role="tab"
            :aria-selected="standingsView === 'players'"
            :class="{ active: standingsView === 'players' }"
            @click="changeStandings('players')"
          >
            Spillere
          </button><button
            role="tab"
            :aria-selected="standingsView === 'teams'"
            :class="{ active: standingsView === 'teams' }"
            @click="changeStandings('teams')"
          >
            Lag
          </button>
        </div>
        <p
          v-if="!standings"
          class="empty-note"
        >
          Tabellen vises etter at turneringen er startet.
        </p>
        <div
          v-else-if="standings.rows.length"
          class="table-wrap"
        >
          <table>
            <caption class="sr-only">
              {{ standingsView === 'players' ? 'Spillertabell' : 'Lagtabell' }}
            </caption><thead>
              <tr>
                <th scope="col">
                  #
                </th><th scope="col">
                  {{ standingsView === 'players' ? 'Spiller' : 'Lag' }}
                </th><th scope="col">
                  V
                </th><th scope="col">
                  +/-
                </th>
              </tr>
            </thead><tbody>
              <tr
                v-for="row in standings.rows"
                :key="`${row.subjectType}:${row.playerIds.join(':')}`"
              >
                <td>
                  <span
                    class="rank-badge"
                    :class="{ 'rank-first': row.rank === 1 }"
                  >{{ row.rank }}</span>
                </td><td><strong>{{ row.name }}</strong><small>{{ row.matchesPlayed }} kamper</small></td><td>{{ row.wins }}</td><td>{{ row.pointDifferential > 0 ? '+' : '' }}{{ row.pointDifferential }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p
          v-else
          class="empty-note"
        >
          Ingen ferdige kamper ennå. Resultatene vises her.
        </p>
        <RouterLink
          class="text-link standings-link"
          to="/history"
        >Se karrierestatistikk <span aria-hidden="true">→</span></RouterLink>
      </section>
    </div>
  </template>
  <div
    v-else
    class="empty-state"
  >
    <h2>Turneringen er ikke tilgjengelig</h2><RouterLink
      class="button button-secondary"
      to="/"
    >Til oversikten</RouterLink>
  </div>
</template>
