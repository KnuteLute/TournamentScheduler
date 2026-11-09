import { describe, expect, it } from 'vitest'
import { friendlyMode, friendlyStatus } from '../src/lib/errors'

describe('Norwegian resource labels', () => {
  it('labels supported user-facing modes without surfacing wire values', () => {
    expect(friendlyMode('2v2_rotating')).toBe('2 mot 2 · roterende lag')
    expect(friendlyMode('1v1')).toBe('1 mot 1')
  })

  it('translates lifecycle states', () => {
    expect(friendlyStatus('paused')).toBe('Satt på pause')
    expect(friendlyStatus('completed')).toBe('Ferdig')
  })
})
