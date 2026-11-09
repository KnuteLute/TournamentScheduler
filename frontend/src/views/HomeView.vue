<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/api/client'
import type { Tournament } from '@/api/types'
import { friendlyMode, friendlyStatus } from '@/lib/errors'

const tournaments = ref<Tournament[]>([])
const loading = ref(true)
const error = ref('')
onMounted(async () => {
  try {
    tournaments.value = (await api.tournaments()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Kunne ikke hente turneringer.'
  } finally { loading.value = false }
})

const activeCount = () => tournaments.value.filter((t) => t.status === 'active' || t.status === 'paused').length
</script>

<template>
  <section class="hero-panel">
    <div class="hero-copy">
      <p class="eyebrow">
        TURNERINGER, UTEN STYR
      </p>
      <h1>Samle folk.<br><span>Start kampen.</span></h1>
      <p class="hero-intro">
        Lag en turnering på et øyeblikk. Vi holder orden på kampene, så dere kan fokusere på spillet.
      </p>
      <div class="hero-actions">
        <RouterLink
          class="button button-primary"
          to="/tournaments/new"
        >Opprett turnering <span aria-hidden="true">↗</span></RouterLink>
        <RouterLink
          class="button button-secondary"
          to="/players"
        >Administrer spillere</RouterLink>
      </div>
    </div>
    <div
      class="hero-art"
      aria-hidden="true"
    >
      <div class="orbit orbit-one" /><div class="orbit orbit-two" />
      <div class="court">
        <span class="court-line" /><span class="court-circle" />
      </div>
      <div class="art-ball">
        ●
      </div><div class="art-tag">
        Klar for spill
      </div>
    </div>
  </section>

  <section class="section-block">
    <div class="section-heading">
      <div>
        <p class="eyebrow">
          DIN SPILLEFLATE
        </p><h2>Turneringer</h2>
      </div>
      <RouterLink
        class="text-link"
        to="/history"
      >Se historikk <span aria-hidden="true">→</span></RouterLink>
    </div>
    <div
      class="stats-strip"
      aria-label="Turneringsstatus"
    >
      <div><strong>{{ tournaments.length }}</strong><span>turneringer totalt</span></div>
      <div><strong>{{ activeCount() }}</strong><span>aktive akkurat nå</span></div>
      <div><strong>{{ tournaments.filter((t) => t.status === 'completed').length }}</strong><span>ferdige turneringer</span></div>
    </div>
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
      Henter turneringer …
    </div>
    <div
      v-else-if="!tournaments.length"
      class="empty-state"
    >
      <span
        class="empty-icon"
        aria-hidden="true"
      >✳</span><h3>Her starter moroa</h3>
      <p>Opprett den første turneringen, og inviter spillerne til banen.</p>
      <RouterLink
        class="button button-primary"
        to="/tournaments/new"
      >Lag din første turnering</RouterLink>
    </div>
    <div
      v-else
      class="tournament-grid"
    >
      <RouterLink
        v-for="tournament in tournaments.slice(0, 6)"
        :key="tournament.id"
        class="tournament-card"
        :to="`/tournaments/${tournament.id}`"
      >
        <div class="card-topline"><span
          class="status-pill"
          :class="`status-${tournament.status}`"
        >{{ friendlyStatus(tournament.status) }}</span><span
          class="card-arrow"
          aria-hidden="true"
        >↗</span></div>
        <h3>{{ tournament.name }}</h3><p>{{ friendlyMode(tournament.mode) }}</p>
        <div class="card-meta"><span>{{ tournament.participants.length }} deltakere</span><span>{{ new Date(tournament.updatedAt).toLocaleDateString('nb-NO') }}</span></div>
      </RouterLink>
    </div>
  </section>
</template>
