// @vitest-environment node
import { describe, expect, it } from 'vitest'
import config from '../vite.config'

describe('Vite development API proxy', () => {
  it('proxies /api to the local backend while preserving the browser Origin', () => {
    const proxy = config.server?.proxy
    expect(proxy).toBeDefined()
    expect(Array.isArray(proxy)).toBe(false)
    if (!proxy || Array.isArray(proxy)) throw new Error('Expected an object API proxy configuration')

    const apiProxy = proxy['/api']
    expect(apiProxy).toMatchObject({
      target: 'http://127.0.0.1:3000',
      changeOrigin: false,
    })
    expect(apiProxy).not.toHaveProperty('rewrite')
  })
})
