import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '@/views/HomeView.vue'
import AuthView from '@/views/AuthView.vue'
import PlayersView from '@/views/PlayersView.vue'
import NewTournamentView from '@/views/NewTournamentView.vue'
import TournamentView from '@/views/TournamentView.vue'
import HistoryView from '@/views/HistoryView.vue'

export const router = createRouter({
  history: createWebHistory('/app/'),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    { path: '/auth', name: 'auth', component: AuthView },
    { path: '/players', name: 'players', component: PlayersView },
    { path: '/tournaments/new', name: 'new-tournament', component: NewTournamentView },
    { path: '/tournaments/:id', name: 'tournament', component: TournamentView, props: true },
    { path: '/history', name: 'history', component: HistoryView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
