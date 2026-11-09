<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import { ApiError } from '@/api/client'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const bootstrapError = ref('')
onMounted(async () => {
  try {
    await session.bootstrap()
  } catch (error) {
    bootstrapError.value = error instanceof ApiError ? error.message : 'Kunne ikke koble til tjenesten.'
  }
})

async function logout() {
  try {
    await session.logout()
  } catch (error) {
    bootstrapError.value = error instanceof Error ? error.message : 'Kunne ikke logge ut.'
  }
}
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <RouterLink
        class="brand"
        to="/"
        aria-label="Kampklar, forsiden"
      >
        <span
          class="brand-mark"
          aria-hidden="true"
        >K</span><span>Kampklar</span>
      </RouterLink>
      <nav
        class="main-nav"
        aria-label="Hovedmeny"
      >
        <RouterLink to="/">Oversikt</RouterLink>
        <RouterLink to="/players">Spillere og lag</RouterLink>
        <RouterLink to="/history">Historikk</RouterLink>
      </nav>
      <div class="account-actions">
        <span
          v-if="session.session"
          class="account-label"
        >
          {{ session.session.account?.username || 'Gjest' }}
        </span>
        <RouterLink
          v-if="session.session?.pendingGuestClaim"
          class="button button-secondary button-small claim-nav-link"
          to="/auth"
        >Løs gjesteoverføring</RouterLink>
        <RouterLink
          v-if="!session.signedIn"
          class="button button-quiet button-small"
          to="/auth"
        >Logg inn</RouterLink>
        <button
          v-else
          class="button button-quiet button-small"
          type="button"
          @click="logout"
        >
          Logg ut
        </button>
      </div>
    </header>
    <main
      id="main-content"
      class="page-frame"
      tabindex="-1"
    >
      <div
        v-if="bootstrapError"
        class="notice notice-error"
        role="alert"
      >
        {{ bootstrapError }}
      </div>
      <div
        v-if="!session.bootstrapped || session.loggingOut"
        class="loading-state"
        role="status"
      >
        {{ session.loggingOut ? 'Logger ut …' : 'Klargjør økten …' }}
      </div>
      <RouterView
        v-else-if="session.session"
        :key="session.ownerGeneration"
      />
      <p
        v-else
        class="notice notice-warning"
        role="status"
      >
        Ingen aktiv økt. Oppdater siden for å prøve igjen.
      </p>
    </main>
    <footer class="site-footer">
      <span>Enklere turneringer. Bedre flyt.</span><span>Sikker økt · Alltid oppdatert fra serveren</span>
    </footer>
  </div>
</template>
