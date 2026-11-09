<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import type { TransferSummary } from '@/api/types'
import { errorMessage } from '@/lib/errors'

const session = useSessionStore()
const router = useRouter()
const registering = ref(false)
const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const transfer = ref<TransferSummary | null>(null)
const names = ref<Record<string, string>>({})
const claimPendingWithoutDetails = computed(() => session.session?.pendingGuestClaim && !transfer.value?.conflicts.length)

async function submit() {
  error.value = ''
  busy.value = true
  try {
    transfer.value = await session.authenticate(username.value, password.value, registering.value)
    if (!transfer.value.conflicts.length) await router.push('/')
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally { busy.value = false }
}

async function resolveClaim() {
  if (!transfer.value) return
  busy.value = true
  error.value = ''
  try {
    await session.claimGuestData(transfer.value.conflicts.map((item) => ({
      resourceType: item.resourceType,
      guestResourceId: item.guestResourceId,
      newName: names.value[`${item.resourceType}:${item.guestResourceId}`] || '',
    })))
    await router.push('/')
  } catch (cause) { error.value = errorMessage(cause) }
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
      <template v-if="transfer?.conflicts.length">
        <p class="eyebrow">
          BEHOLD ALT SAMLET
        </p><h2>Noen navn må avklares</h2>
        <p>Velg nye navn for gjestespillerne som kolliderer med kontoen din. Historikken og ID-ene beholdes.</p>
        <form @submit.prevent="resolveClaim">
          <label
            v-for="item in transfer.conflicts"
            :key="`${item.resourceType}:${item.guestResourceId}`"
            class="field-label"
          >
            {{ item.resourceType === 'player' ? 'Spiller' : 'Lag' }} · {{ item.guestName }}
            <input
              v-model="names[`${item.resourceType}:${item.guestResourceId}`]"
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
      <template v-else>
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
        <p
          v-if="claimPendingWithoutDetails"
          class="notice notice-warning"
          role="status"
        >
          En gjesteoverføring venter på navneavklaring. API-et leverer ikke konfliktlisten på nytt etter at økten er lastet inn. Behold innloggingssvaret med konfliktene tilgjengelig, eller kontakt administrator for hjelp.
        </p>
      </template>
    </div>
  </section>
</template>
