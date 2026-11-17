import type {
  DiscoveryQueueItem,
  DiscoveryQueueStatus
} from '../../../shared/contracts'

const allowedTransitions: Record<
  DiscoveryQueueStatus,
  readonly DiscoveryQueueStatus[]
> = {
  discovering: ['needs-review', 'failed', 'cancelled'],
  'needs-review': ['ready', 'discovering', 'queued', 'failed'],
  ready: ['needs-review', 'discovering', 'queued', 'failed'],
  queued: ['downloading', 'paused', 'cancelled', 'failed', 'discovering'],
  downloading: [
    'queued',
    'paused',
    'completed',
    'partially-completed',
    'packaging-failed',
    'failed',
    'cancelled'
  ],
  paused: ['queued', 'cancelled', 'failed'],
  completed: [],
  'partially-completed': ['queued', 'failed'],
  'packaging-failed': ['queued'],
  failed: ['discovering', 'queued', 'cancelled'],
  cancelled: ['discovering', 'queued']
}

export function transitionQueueItem(
  item: DiscoveryQueueItem,
  nextStatus: DiscoveryQueueStatus
): void {
  if (item.status === nextStatus) return
  if (!allowedTransitions[item.status].includes(nextStatus)) {
    throw new Error(
      `Invalid queue status transition for "${item.title}": ${item.status} → ${nextStatus}.`
    )
  }
  item.status = nextStatus
}
