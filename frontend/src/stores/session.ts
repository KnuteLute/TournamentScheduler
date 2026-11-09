import { defineStore } from 'pinia'
import { api, setApiCsrfToken } from '@/api/client'
import type { AuthResult, Session } from '@/api/types'

export const useSessionStore = defineStore('session', {
  state: () => ({ session: null as Session | null, bootstrapped: false, busy: false }),
  getters: {
    signedIn: (state) => state.session?.kind === 'authenticated',
  },
  actions: {
    apply(session: Session | null) {
      this.session = session
      setApiCsrfToken(session?.csrfToken)
    },
    async bootstrap() {
      this.busy = true
      try {
        const { data } = await api.session()
        this.apply(data)
      } finally {
        this.bootstrapped = true
        this.busy = false
      }
    },
    async authenticate(username: string, password: string, register = false) {
      const { data } = await (register ? api.register(username, password) : api.login(username, password))
      this.apply((data as AuthResult).session)
      return (data as AuthResult).transfer
    },
    async logout() {
      await api.logout()
      this.apply(null)
      await this.bootstrap()
    },
    async claimGuestData(resolutions: Parameters<typeof api.claimGuestData>[0]) {
      await api.claimGuestData(resolutions)
      await this.bootstrap()
    },
  },
})
