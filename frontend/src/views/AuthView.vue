<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { errorMessage } from '@/lib/errors'

const session = useSessionStore()
const router = useRouter()
const registering = ref(false)
const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const names = ref<Record<string, string>>({})
const claimConflicts = computed(() => session.pendingClaim?.conflicts || [])
const claimPendingWithoutDetails = computed(() => session.session?.pendingGuestClaim && !claimConflicts.value.length)

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await session.authenticate(username.value, password.value, registering.value)
    if (!session.session?.pendingGuestClaim) await router.push('/')
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally { busy.value = false }
}

async function resolveClaim() {
  if (!session.pendingClaim?.conflicts.length) return
  busy.value = true
  error.value = ''
  try {
    await session.claimGuestData(session.pendingClaim.conflicts.map((item) => ({
      resourceType: item.entityKind,
      guestResourceId: item.resourceId,
      newName: names.value[`${item.entityKind}:${item.resourceId}`] || '',
    })))
    await router.push('/')
  } catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}

async function loadPendingClaim() {
  busy.value = true
  error.value = ''
  try { await session.refreshPendingClaim() }
  catch (cause) { error.value = errorMessage(cause) }
  finally { busy.value = false }
}
</script>

<template>
  <section class="auth-layout">
    <div class="auth-aside">
      <p class="eyebrow">
        DIN TURNERING, DINE FOLK
      </p><h1>Spill videre,<br><span>uansett hvor.</span></h1><p>Logg inn for å ta med deg spillere og turneringshistorikk mellom økter.</p><div
        class="auth-stamp"
        aria-hidden="true"
      >
        🏆 <span>Spill sammen</span>
      </div>
    </div>
    <div class="form-card auth-card">
      <template v-if="claimConflicts.length">
        <p class="eyebrow">
          BEHOLD ALT SAMLET
        </p><h2>Noen navn må avklares</h2>
        <p>Velg nye navn for gjestespillerne som kolliderer med kontoen din. Historikken og ID-ene beholdes.</p>
        <form @submit.prevent="resolveClaim">
          <label
            v-for="item in claimConflicts"
            :key="`${item.entityKind}:${item.resourceId}`"
            class="field-label"
          >
            {{ item.entityKind === 'player' ? 'Spiller' : 'Lag' }} · {{ item.displayName }}
            <span class="helper-text">Navnet kolliderer med: {{ item.collisionNames.join(', ') }}</span>
            <input
              v-model="names[`${item.entityKind}:${item.resourceId}`]"
              required
              maxlength="80"
              autocomplete="off"
            >
          </label>
          <p
            v-if="error"
            class="notice notice-error"
            role="alert"
          >
            {{ error }}
          </p>
          <button
            class="button button-primary button-full"
            :disabled="busy"
            type="submit"
          >
            {{ busy ? 'Lagrer …' : 'Løs navnekonflikter' }}
          </button>
        </form>
      </template>
      <template v-else-if="!session.session?.pendingGuestClaim">
        <p class="eyebrow">
          VELKOMMEN TILBAKE
        </p><h2>{{ registering ? 'Opprett konto' : 'Logg inn' }}</h2>
        <p>Du kan spille som gjest uten konto. Kontoen din tar vare på historikken.</p>
        <form @submit.prevent="submit">
          <label class="field-label">Brukernavn<input
            v-model="username"
            required
            minlength="3"
            maxlength="64"
            autocomplete="username"
          ></label>
          <label class="field-label">Passord<input
            v-model="password"
            required
            minlength="12"
            maxlength="128"
            :autocomplete="registering ? 'new-password' : 'current-password'"
            type="password"
          ></label>
          <p class="helper-text">
            {{ registering ? 'Bruk minst 12 tegn.' : 'Passordet sendes sikkert til serveren.' }}
          </p>
          <p
            v-if="error"
            class="notice notice-error"
            role="alert"
          >
            {{ error }}
          </p>
          <button
            class="button button-primary button-full"
            :disabled="busy"
            type="submit"
          >
            {{ busy ? 'Et øyeblikk …' : registering ? 'Opprett konto' : 'Logg inn' }}
          </button>
        </form>
        <button
          class="switch-auth"
          type="button"
          @click="registering = !registering; error = ''"
        >
          {{ registering ? 'Har du allerede en konto? Logg inn' : 'Ny her? Opprett konto' }}
        </button>
      </template>
      <template v-else>
        <p class="eyebrow">
          GJESTEOVERFØRING
        </p>
        <h2>Hent navneavklaringer</h2>
        <p>En gjesteoverføring venter. Hent de ventende navnekonfliktene for å fortsette.</p>
        <p
          v-if="error"
          class="notice notice-error"
          role="alert"
        >
          {{ error }}
        </p>
        <p
          v-if="claimPendingWithoutDetails"
          class="notice notice-warning"
          role="status"
        >
          Ingen konfliktopplysninger er lastet inn ennå.
        </p>
        <button
          class="button button-primary button-full"
          :disabled="busy"
          @click="loadPendingClaim"
        >
          {{ busy ? 'Henter …' : 'Hent navnekonflikter' }}
        </button>
      </template>
    </div>
  </section>
</template>
