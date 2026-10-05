import type { AckStatus, Delivery } from './protocol'
import { markSeen, readState } from './store'

export type { Delivery } from './protocol'

export type HeraldWorkerOptions = {
  // Opened when a notification has no link or an untrusted one. Defaults to
  // the service worker scope.
  fallbackUrl?: string
  icon?: string
  badge?: string
}

// Posted to every window client after each Herald push.
export type HeraldWorkerMessage = {
  type: 'herald:delivery'
  deliveryId: string
  outcome: 'displayed' | 'duplicate' | 'suppressed'
  ack?: number
}

type NotificationData = { herald: { link?: string } }

export function installHerald(scope: ServiceWorkerGlobalScope, options: HeraldWorkerOptions = {}): void {
  scope.addEventListener('push', (event) => {
    const delivery = parse(event.data)
    if (delivery) event.waitUntil(handleDelivery(scope, delivery, options))
  })

  scope.addEventListener('notificationclick', (event) => {
    const data = event.notification.data as NotificationData | undefined
    if (!data?.herald) return
    event.notification.close()
    const fallback = new URL(options.fallbackUrl ?? scope.registration.scope, scope.location.origin).href
    event.waitUntil(openWindow(scope, trustedUrl(data.herald.link, scope.location.origin) ?? fallback))
  })
}

// Payloads without a delivery ID are left to the product's own handlers.
function parse(data: PushMessageData | null): Delivery | undefined {
  try {
    const value = data?.json() as Partial<Delivery> | undefined
    if (typeof value?.delivery_id === 'string' && typeof value.message?.title === 'string') return value as Delivery
  } catch {
    return undefined
  }
  return undefined
}

async function handleDelivery(scope: ServiceWorkerGlobalScope, delivery: Delivery, options: HeraldWorkerOptions) {
  const { message } = delivery
  const fresh = await markSeen(delivery.delivery_id)

  if (Date.parse(message.expires_at) <= Date.now()) {
    const ack = fresh ? await acknowledge(delivery.delivery_id, 'suppressed') : undefined
    return notify(scope, { deliveryId: delivery.delivery_id, outcome: 'suppressed', ack })
  }

  // Browsers require a visible notification per push, so a duplicate is shown
  // again only when nothing with its tag is open. Replacing an open one could
  // bring back a message its collapse key has since superseded.
  const tag = message.collapse_key || delivery.delivery_id
  if (!fresh && (await scope.registration.getNotifications({ tag })).length > 0) {
    return notify(scope, { deliveryId: delivery.delivery_id, outcome: 'duplicate' })
  }
  await scope.registration.showNotification(message.title, {
    body: message.body,
    tag,
    timestamp: Date.parse(message.created_at),
    icon: options.icon,
    badge: options.badge,
    data: { herald: { link: message.link } } satisfies NotificationData,
  } as NotificationOptions)

  if (!fresh) return notify(scope, { deliveryId: delivery.delivery_id, outcome: 'duplicate' })
  const ack = await acknowledge(delivery.delivery_id, 'displayed')
  return notify(scope, { deliveryId: delivery.delivery_id, outcome: 'displayed', ack })
}

// Best effort: a lost ack only affects Herald's delivery counts.
async function acknowledge(deliveryId: string, status: AckStatus): Promise<number | undefined> {
  const state = await readState()
  if (!state) return undefined
  try {
    const response = await fetch(`${state.heraldUrl}/v1/deliveries/${encodeURIComponent(deliveryId)}/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.deviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    return response.status
  } catch {
    return undefined
  }
}

async function notify(scope: ServiceWorkerGlobalScope, message: Omit<HeraldWorkerMessage, 'type'>) {
  const clients = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of clients) client.postMessage({ type: 'herald:delivery', ...message })
}

// Mirrors Herald's publish-time check: only a single-slash path on this
// origin may be opened.
export function trustedUrl(link: string | undefined, origin: string): string | undefined {
  if (!link || !link.startsWith('/') || link.startsWith('//') || link.startsWith('/\\')) return undefined
  const url = new URL(link, origin)
  return url.origin === origin ? url.href : undefined
}

async function openWindow(scope: ServiceWorkerGlobalScope, url: string) {
  const clients = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const exact = clients.find((client) => client.url === url)
  if (exact) return exact.focus()
  const sameOrigin = clients.find((client) => new URL(client.url).origin === scope.location.origin)
  if (sameOrigin) {
    try {
      const navigated = await sameOrigin.navigate(url)
      if (navigated) return navigated.focus()
    } catch {
      // Uncontrolled clients cannot be navigated; fall through to a new window.
    }
  }
  return scope.clients.openWindow(url)
}
