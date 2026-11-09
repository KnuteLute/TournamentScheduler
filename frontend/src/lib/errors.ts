import { ApiError } from '@/api/client'

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const fields = error.problem?.errors?.map((item) => item.message).filter(Boolean) || []
    return fields.length ? `${error.message} ${fields.join(' ')}` : error.message
  }
  return error instanceof Error ? error.message : 'Noe gikk galt. Prøv igjen.'
}

export async function showError(
  action: () => Promise<unknown>,
  onError: (message: string) => void,
): Promise<boolean> {
  try {
    await action()
    return true
  } catch (error) {
    onError(errorMessage(error))
    return false
  }
}

export function friendlyStatus(status: string): string {
  const labels: Record<string, string> = {
    draft: 'Kladd', active: 'Pågår', paused: 'Satt på pause',
    completed: 'Ferdig', cancelled: 'Avlyst',
  }
  return labels[status] || status
}

export function friendlyMode(mode: string): string {
  if (mode === '2v2_rotating') return '2 mot 2 · roterende lag'
  if (mode === '2v2_fixed') return '2 mot 2 · faste lag'
  return '1 mot 1'
}
