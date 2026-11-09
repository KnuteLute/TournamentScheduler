import { defineStore } from 'pinia'
import { api, setApiCsrfToken } from '@/api/client'
import type { AuthResult, PendingGuestClaim, Session } from '@/api/types'

export const useSessionStore = defineStore('session', {
  state: () => ({
    session: null as Session | null,
    pendingClaim: null as PendingGuestClaim | null,
    pendingClaimEtag: null as string | null,
    bootstrapped: false,
    busy: false,
  }),
  getters: {
    signedIn: (state) => state.session?.kind === 'authenticated',
  },
  actions: {
    apply(session: Session | null) {
      this.session = session
      setApiCsrfToken(session?.csrfToken)
      if (!session?.pendingGuestClaim) {
        this.pendingClaim = null
        this.pendingClaimEtag = null
      }
    },
    async refreshPendingClaim() {
      if (!this.session?.pendingGuestClaim) {
        this.pendingClaim = null
        this.pendingClaimEtag = null
        return
      }
      const { data, etag } = await api.pendingGuestClaim()
      this.pendingClaim = data
      this.pendingClaimEtag = etag
    },
    async bootstrap() {
      this.busy = true
      try {
        const { data } = await api.session()
        this.apply(data)
        await this.refreshPendingClaim()
      } finally {
        this.bootstrapped = true
        this.busy = false
      }
    },
    async authenticate(username: string, password: string, register = false) {
      const { data } = await (register ? api.register(username, password) : api.login(username, password))
      const result = data as AuthResult
      this.apply(result.session)
      if (result.session.pendingGuestClaim) {
        this.pendingClaim = { pending: true, conflicts: result.transfer.conflicts }
        await this.refreshPendingClaim()
      }
      return result.transfer
    },
    async logout() {
      await api.logout()
      this.apply(null)
      await this.bootstrap()
    },
    async claimGuestData(resolutions: Parameters<typeof api.claimGuestData>[0]) {
      await this.refreshPendingClaim()
      if (!this.pendingClaimEtag) throw new Error('Mangler versjon for gjesteoverføring. Last inn siden på nytt.')
      await api.claimGuestData(resolutions, this.pendingClaimEtag)
      await this.bootstrap()
    },
  },
})
