<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { RouterLink } from 'vue-router'
import { api } from '@/api/client'
import type { Player, TournamentMode } from '@/api/types'
import { errorMessage } from '@/lib/errors'

const router = useRouter()
const players = ref<Player[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const tournamentName = ref('')
const mode = ref<TournamentMode>('2v2_rotating')
const selected = ref<string[]>([])
const modes: { value: TournamentMode; title: string; copy: string; symbol: string }[] = [
  { value: '2v2_rotating', title: '2 mot 2 · roterende lag', copy: 'Nye makkere underveis. Perfekt når alle skal spille med alle.', symbol: '⟳' },
  { value: '1v1', title: '1 mot 1', copy: 'Klassisk alle-mot-alle. Hver spiller møter hverandre.', symbol: '↔' },
]
const minimum = computed(() => mode.value === '1v1' ? 2 : 4)
const enoughPlayers = computed(() => selected.value.length >= minimum.value)
onMounted(async () => {
  try { players.value = await api.players() }
  catch (cause) { error.value = errorMessage(cause) }
  finally { loading.value = false }
})

async function create() {
  saving.value = true; error.value = ''
  try {
    const { data } = await api.createTournament({ name: tournamentName.value, mode: mode.value, playerIds: selected.value })
    await router.push(`/tournaments/${data.id}`)
  } catch (cause) { error.value = errorMessage(cause) }
  finally { saving.value = false }
}
</script>

<template>
  <section class="page-heading">
    <p class="eyebrow">
      NY SPILLEKVELD
    </p><h1>Sett opp turneringen</h1><p>Velg format og inviter spillerne. Kampene lages når du starter.</p>
  </section>
  <div class="setup-layout">
    <form
      class="setup-main"
      @submit.prevent="create"
    >
      <section class="content-card setup-section">
        <div class="step-heading">
          <span>01</span><div><h2>Hva skal turneringen hete?</h2><p>Et navn gjør det lett å finne den igjen i historikken.</p></div>
        </div><label
          class="sr-only"
          for="tournament-name"
        >Turneringsnavn</label><input
          id="tournament-name"
          v-model="tournamentName"
          class="large-input"
          maxlength="100"
          placeholder="For eksempel: Sommerens klubbkveld"
          required
        >
      </section>
      <section class="content-card setup-section">
        <div class="step-heading">
          <span>02</span><div><h2>Velg spillformat</h2><p>Start med roterende lag, eller spill klassisk én mot én.</p></div>
        </div><div
          class="mode-options"
          role="radiogroup"
          aria-label="Spillformat"
        >
          <button
            v-for="item in modes"
            :key="item.value"
            class="mode-option"
            :class="{ selected: mode === item.value }"
            type="button"
            role="radio"
            :aria-checked="mode === item.value"
            @click="mode = item.value; selected = []"
          >
            <span
              class="mode-symbol"
              aria-hidden="true"
            >{{ item.symbol }}</span><span class="mode-copy"><strong>{{ item.title }}</strong><small>{{ item.copy }}</small></span><span
              class="radio-dot"
              aria-hidden="true"
            />
          </button>
        </div>
      </section>
      <section class="content-card setup-section">
        <div class="step-heading">
          <span>03</span><div><h2>Hvem blir med?</h2><p>Velg minst {{ minimum }} spillere. Du kan endre utvalget mens turneringen er en kladd.</p></div>
        </div>
        <div
          v-if="loading"
          class="loading-state"
          role="status"
        >
          Henter spillere …
        </div>
        <div
          v-else-if="players.length"
          class="player-grid"
        >
          <label
            v-for="player in players"
            :key="player.id"
            class="select-player"
            :class="{ chosen: selected.includes(player.id) }"
          ><input
            v-model="selected"
            type="checkbox"
            :value="player.id"
          ><span
            class="avatar avatar-player"
            aria-hidden="true"
          >{{ player.name.slice(0, 1).toUpperCase() }}</span><span>{{ player.name }}</span><span
            v-if="selected.includes(player.id)"
            class="selected-check"
            aria-hidden="true"
          >✓</span></label>
        </div>
        <div
          v-else
          class="empty-inline"
        >
          <p>Du har ikke lagt til spillere ennå.</p><RouterLink
            class="text-link"
            to="/players"
          >Legg til spillere først →</RouterLink>
        </div>
      </section>
      <p
        v-if="error"
        class="notice notice-error"
        role="alert"
      >
        {{ error }}
      </p>
      <div class="setup-footer">
        <RouterLink
          class="button button-quiet"
          to="/"
        >Avbryt</RouterLink><button
          class="button button-primary"
          :disabled="saving || loading || !tournamentName.trim() || !enoughPlayers"
        >
          {{ saving ? 'Oppretter …' : 'Opprett kladd' }} <span aria-hidden="true">→</span>
        </button>
      </div>
    </form>
    <aside class="setup-aside">
      <div class="setup-summary">
        <p class="eyebrow">
          DIN PLAN
        </p><div class="summary-block">
          <span class="summary-number">{{ selected.length.toString().padStart(2, '0') }}</span><div><strong>spillere valgt</strong><small>Minst {{ minimum }} for å starte</small></div>
        </div><div class="summary-divider" /><p class="summary-label">
          FORMAT
        </p><strong>{{ mode === '2v2_rotating' ? 'Roterende 2 mot 2' : '1 mot 1' }}</strong><p class="summary-note">
          Du oppretter først en kladd. Kampene og spilleplanen opprettes av serveren når du starter turneringen.
        </p>
      </div><div class="tip-card">
        <span aria-hidden="true">✦</span><p><strong>Et lite tips</strong><br>I roterende 2 mot 2 finner serveren nye makkerpar og passer på at alle får spille.</p>
      </div>
    </aside>
  </div>
</template>
