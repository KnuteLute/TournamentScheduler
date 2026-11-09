<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api/client'
import type { Player, Team } from '@/api/types'
import { errorMessage } from '@/lib/errors'

const players = ref<Player[]>([])
const teams = ref<Team[]>([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const playerName = ref('')
const teamName = ref('')
const selectedPlayers = ref<string[]>([])
const editingPlayer = ref<string | null>(null)
const editPlayerName = ref('')
const editingTeam = ref<string | null>(null)
const editTeamName = ref('')
const editTeamPlayers = ref<string[]>([])
const availableForTeams = computed(() => players.value)

async function load() {
  error.value = ''
  try { [players.value, teams.value] = await Promise.all([api.players(), api.teams()]) }
  catch (cause) { error.value = errorMessage(cause) }
  finally { loading.value = false }
}
onMounted(load)

async function addPlayer() {
  if (!playerName.value.trim()) return
  saving.value = true; error.value = ''
  try { await api.createPlayer(playerName.value); playerName.value = ''; await load() }
  catch (cause) { error.value = errorMessage(cause) }
  finally { saving.value = false }
}

async function addTeam() {
  if (selectedPlayers.value.length !== 2 || !teamName.value.trim()) return
  saving.value = true; error.value = ''
  try { await api.createTeam(teamName.value, selectedPlayers.value); teamName.value = ''; selectedPlayers.value = []; await load() }
  catch (cause) { error.value = errorMessage(cause) }
  finally { saving.value = false }
}

async function savePlayer(player: Player) {
  saving.value = true; error.value = ''
  try { await api.updatePlayer(player.id, editPlayerName.value); editingPlayer.value = null; await load() }
  catch (cause) { error.value = errorMessage(cause) }
  finally { saving.value = false }
}
async function removePlayer(player: Player) {
  if (!window.confirm(`Slette ${player.name}?`)) return
  error.value = ''
  try { await api.deletePlayer(player.id); await load() }
  catch (cause) { error.value = errorMessage(cause) }
}
async function saveTeam(team: Team) {
  saving.value = true; error.value = ''
  try { await api.updateTeam(team.id, { name: editTeamName.value, playerIds: editTeamPlayers.value }); editingTeam.value = null; await load() }
  catch (cause) { error.value = errorMessage(cause) }
  finally { saving.value = false }
}
async function removeTeam(team: Team) {
  if (!window.confirm(`Slette laget ${team.name}?`)) return
  error.value = ''
  try { await api.deleteTeam(team.id); await load() }
  catch (cause) { error.value = errorMessage(cause) }
}
</script>

<template>
  <section class="page-heading page-heading-row">
    <div>
      <p class="eyebrow">
        LAGET DITT
      </p><h1>Spillere og lag</h1><p>Hold styr på gjengen og sett sammen faste lag når dere trenger det.</p>
    </div>
    <span
      class="heading-illustration"
      aria-hidden="true"
    >✳</span>
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
    Henter spillere …
  </div>
  <div
    v-else
    class="management-grid"
  >
    <section class="content-card">
      <div class="section-heading compact">
        <div>
          <p class="eyebrow">
            SPILLERLISTE
          </p><h2>Spillerne dine <span class="count-badge">{{ players.length }}</span></h2>
        </div>
      </div>
      <form
        class="inline-create"
        @submit.prevent="addPlayer"
      >
        <label
          class="sr-only"
          for="player-name"
        >Navn på ny spiller</label><input
          id="player-name"
          v-model="playerName"
          maxlength="80"
          placeholder="Legg til en spiller …"
          required
        ><button
          class="button button-primary"
          :disabled="saving"
        >
          Legg til
        </button>
      </form>
      <ul
        v-if="players.length"
        class="people-list"
      >
        <li
          v-for="player in players"
          :key="player.id"
          class="person-row"
        >
          <span
            class="avatar avatar-player"
            aria-hidden="true"
          >{{ player.name.slice(0, 1).toUpperCase() }}</span>
          <form
            v-if="editingPlayer === player.id"
            class="edit-row"
            @submit.prevent="savePlayer(player)"
          >
            <label
              class="sr-only"
              :for="`edit-player-${player.id}`"
            >Endre spillernavn</label><input
              :id="`edit-player-${player.id}`"
              v-model="editPlayerName"
              maxlength="80"
              required
            ><button
              class="icon-button"
              :disabled="saving"
              aria-label="Lagre navn"
            >
              ✓
            </button><button
              class="icon-button"
              type="button"
              aria-label="Avbryt"
              @click="editingPlayer = null"
            >
              ×
            </button>
          </form>
          <span
            v-else
            class="person-name"
          >{{ player.name }}</span>
          <div
            v-if="editingPlayer !== player.id"
            class="row-actions"
          >
            <button
              class="icon-button"
              type="button"
              :aria-label="`Endre ${player.name}`"
              @click="editingPlayer = player.id; editPlayerName = player.name"
            >
              ✎
            </button><button
              class="icon-button danger-action"
              type="button"
              :aria-label="`Slett ${player.name}`"
              @click="removePlayer(player)"
            >
              ×
            </button>
          </div>
        </li>
      </ul>
      <div
        v-else
        class="mini-empty"
      >
        <span aria-hidden="true">◌</span><p>Ingen spillere ennå. Legg til den første over.</p>
      </div>
    </section>

    <section class="content-card team-card">
      <div class="section-heading compact">
        <div>
          <p class="eyebrow">
            FAVORITTMAKKERE
          </p><h2>Faste lag <span class="count-badge">{{ teams.length }}</span></h2>
        </div>
      </div>
      <p class="card-intro">
        Sett sammen par som kan brukes igjen. Faste lag er tilgjengelige for administrasjon, men vises ikke som turneringsmodus.
      </p>
      <form
        class="team-create"
        @submit.prevent="addTeam"
      >
        <label class="field-label">Lagnavn<input
          v-model="teamName"
          maxlength="80"
          placeholder="For eksempel: Lynrask duo"
          required
        ></label>
        <fieldset class="player-picker">
          <legend>Velg to spillere</legend><label
            v-for="player in players"
            :key="player.id"
            class="check-row"
          ><input
            v-model="selectedPlayers"
            type="checkbox"
            :value="player.id"
            :disabled="!selectedPlayers.includes(player.id) && selectedPlayers.length >= 2"
          ><span>{{ player.name }}</span></label><p
            v-if="!players.length"
            class="helper-text"
          >
            Legg til spillere før du lager lag.
          </p>
        </fieldset>
        <button
          class="button button-secondary button-full"
          :disabled="saving || selectedPlayers.length !== 2 || !teamName.trim()"
        >
          Opprett fast lag
        </button>
      </form>
      <ul
        v-if="teams.length"
        class="team-list"
      >
        <li
          v-for="team in teams"
          :key="team.id"
          class="team-item"
        >
          <div
            v-if="editingTeam === team.id"
            class="team-edit-form"
          >
            <label class="field-label">Lagnavn<input
              v-model="editTeamName"
              maxlength="80"
              required
            ></label>
            <fieldset class="player-picker">
              <legend>Spillere</legend><label
                v-for="player in availableForTeams"
                :key="player.id"
                class="check-row"
              ><input
                v-model="editTeamPlayers"
                type="checkbox"
                :value="player.id"
                :disabled="!editTeamPlayers.includes(player.id) && editTeamPlayers.length >= 2"
              ><span>{{ player.name }}</span></label>
            </fieldset>
            <div class="button-row">
              <button
                class="button button-primary button-small"
                :disabled="saving || editTeamPlayers.length !== 2"
                @click="saveTeam(team)"
              >
                Lagre
              </button><button
                class="button button-quiet button-small"
                @click="editingTeam = null"
              >
                Avbryt
              </button>
            </div>
          </div>
          <template v-else>
            <div
              class="team-emblem"
              aria-hidden="true"
            >
              ＋
            </div><div class="team-info">
              <strong>{{ team.name }}</strong><span>{{ team.players.map((p) => p.name).join(' & ') }}</span>
            </div><div class="row-actions">
              <button
                class="icon-button"
                type="button"
                :aria-label="`Endre ${team.name}`"
                @click="editingTeam = team.id; editTeamName = team.name; editTeamPlayers = team.players.map((p) => p.id)"
              >
                ✎
              </button><button
                class="icon-button danger-action"
                type="button"
                :aria-label="`Slett ${team.name}`"
                @click="removeTeam(team)"
              >
                ×
              </button>
            </div>
          </template>
        </li>
      </ul>
      <div
        v-else
        class="mini-empty"
      >
        <span aria-hidden="true">⌁</span><p>Faste lag gjør det enkelt å samle favorittduoene.</p>
      </div>
    </section>
  </div>
</template>
