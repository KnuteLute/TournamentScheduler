import type { StandingRow } from '@/api/types'

export function standingRowKey(row: StandingRow): string {
  if (row.subjectType === 'fixed_team') {
    return `fixed_team:${row.teamId ?? row.playerIds.join(':')}`
  }
  if (row.subjectType === 'rotating_pair') {
    return `rotating_pair:${[...row.playerIds].sort().join(':')}`
  }
  return `${row.subjectType}:${row.playerIds[0]}`
}
