<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/api/client'
import type { Standings, StandingsView, Tournament } from '@/api/types'
import { errorMessage, friendlyMode, friendlyStatus } from '@/lib/errors'

const tournaments = ref<Tournament[]>([])
const standings = ref<Standings | null>(null)
const view = ref<StandingsView>('players')
const loading = ref(true)
const error = ref('')
async function updateStandings(next: StandingsView) {
  view.value = next
  try { standings.value = (await api.standings(next)).data }
  catch (cause) { error.value = errorMessage(cause) }
}
onMounted(async () => {
  try {
    [tournaments.value, standings.value] = await Promise.all([api.tournaments(), api.standings(view.value).then((result) => result.data)])
    tournaments.value.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch (cause) { error.value = errorMessage(cause) }
  finally { loading.value = false }
})
</script>

<template>
  <section class="page-heading page-heading-row">
    <div>
      <p class="eyebrow">
        ALT DERE HAR SPILT
      </p><h1>Turneringshistorikk</h1><p>Resultater og statistikk, samlet på ett sted.</p>
    </div><span
      class="heading-illustration"
      aria-hidden="true"
    >⌁</span>
  </section>
  <p
    v-if="error"
    class="notice notice-error"
    role="alert"
  >
    {{ error }}
  </p>
  <div
    v-if="loading"
    class="loading-state"
    role="status"
  >
    Henter historikk …
  </div>
  <template v-else>
    <section class="content-card history-standings">
      <div class="section-heading compact">
        <div>
          <p class="eyebrow">
            KARRIERESTATISTIKK
          </p><h2>Sammenlagt</h2>
        </div><div
          class="segmented-control"
          role="tablist"
          aria-label="Sammenlagt tabell"
        >
          <button
            role="tab"
            :aria-selected="view === 'players'"
            :class="{ active: view === 'players' }"
            @click="updateStandings('players')"
          >
            Spillere
          </button><button
            role="tab"
            :aria-selected="view === 'teams'"
            :class="{ active: view === 'teams' }"
            @click="updateStandings('teams')"
          >
            Lag og makkere
          </button>
        </div>
      </div>
      <div
        v-if="standings?.rows.length"
        class="table-wrap"
      >
        <table>
          <caption class="sr-only">
            Sammenlagt {{ view === 'players' ? 'spillertabell' : 'lagtabell' }}
          </caption><thead>
            <tr>
              <th scope="col">
                Plass
              </th><th scope="col">
                {{ view === 'players' ? 'Spiller' : 'Lag / makkerpar' }}
              </th><th scope="col">
                Kamper
              </th><th scope="col">
                Seier
              </th><th scope="col">
                Uavgjort
              </th><th scope="col">
                Tap
              </th><th scope="col">
                Poengforskjell
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
              </td><td><strong>{{ row.name }}</strong><small>{{ row.subjectType === 'rotating_pair' ? 'Makkerpar' : row.subjectType === 'fixed_team' ? 'Fast lag' : 'Spiller' }}</small></td><td>{{ row.matchesPlayed }}</td><td>{{ row.wins }}</td><td>{{ row.draws }}</td><td>{{ row.losses }}</td><td>{{ row.pointDifferential > 0 ? '+' : '' }}{{ row.pointDifferential }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p
        v-else
        class="empty-note"
      >
        Statistikk dukker opp når dere har spilt ferdige kamper.
      </p>
    </section>
    <section class="section-block history-section">
      <div class="section-heading">
        <div>
          <p class="eyebrow">
            SPILLEKVELDENE
          </p><h2>Alle turneringer <span class="count-badge">{{ tournaments.length }}</span></h2>
        </div>
      </div>
      <div
        v-if="tournaments.length"
        class="history-list"
      >
        <RouterLink
          v-for="tournament in tournaments"
          :key="tournament.id"
          :to="`/tournaments/${tournament.id}`"
          class="history-item"
        ><span class="history-date">{{ new Date(tournament.updatedAt).toLocaleDateString('nb-NO', { day: '2-digit', month: 'short', year: 'numeric' }) }}</span><span class="history-name"><strong>{{ tournament.name }}</strong><small>{{ friendlyMode(tournament.mode) }} · {{ tournament.participants.length }} deltakere</small></span><span
          class="status-pill"
          :class="`status-${tournament.status}`"
        >{{ friendlyStatus(tournament.status) }}</span><span
          class="history-arrow"
          aria-hidden="true"
        >→</span></RouterLink>
      </div>
      <div
        v-else
        class="empty-state"
      >
        <span
          class="empty-icon"
          aria-hidden="true"
        >⌁</span><h3>Historien starter snart</h3><p>Turneringene dine blir tatt vare på her.</p><RouterLink
          class="button button-primary"
          to="/tournaments/new"
        >Opprett turnering</RouterLink>
      </div>
    </section>
  </template>
</template>
