import {
  test as base,
  chromium,
  expect,
  type BrowserContext,
  type CDPSession,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Delivery, Subscription } from '../src/protocol'
import { DEMO_ORIGIN, sql, storedDelivery } from './harness'

export { expect }

// Real deliveries go through the push service; allow for its latency.
export const PUSH_TIMEOUT = 60_000

type Permission = 'granted' | 'denied' | 'prompt'

// Real push subscriptions need branded Chrome and a persistent profile. A new
// profile's first subscription waits on a push service check-in, so the
// profile is kept per worker. The demo origin's data is cleared around each
// test: every test still starts as a new device.
export const test = base.extend<
  { permission: Permission; context: BrowserContext; page: Page },
  { profile: BrowserContext }
>({
  profile: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires the destructuring
    async ({}, use) => {
      const directory = mkdtempSync(join(tmpdir(), 'herald-web-'))
      const context = await chromium.launchPersistentContext(directory, {
        channel: 'chrome',
        headless: true,
        baseURL: DEMO_ORIGIN,
      })
      await use(context)
      await context.close()
      rmSync(directory, { recursive: true, force: true })
    },
    { scope: 'worker' },
  ],
  permission: ['granted', { option: true }],
  context: async ({ profile, permission }, use) => {
    const cdp = await profile.newCDPSession(profile.pages()[0] ?? (await profile.newPage()))
    await resetOrigin(profile, cdp, permission)
    await use(profile)
    await resetOrigin(profile, cdp, permission)
    await cdp.detach()
  },
  // A new page per test; the first page only keeps the profile open.
  page: async ({ context }, use) => {
    const page = await context.newPage()
    await use(page)
    await page.close()
  },
})

// Clears the demo origin's storage, worker and push subscription, and removes
// every Herald subscription: devices from earlier tests stay in the database
// and would otherwise count toward later fan-outs.
async function resetOrigin(profile: BrowserContext, cdp: CDPSession, permission: Permission) {
  await cdp.send('Storage.clearDataForOrigin', { origin: DEMO_ORIGIN, storageTypes: 'all' })
  sql('DELETE FROM subscriptions')
  await profile.clearPermissions()
  if (permission === 'granted') await profile.grantPermissions(['notifications'], { origin: DEMO_ORIGIN })
  for (const name of ['notifications', 'push']) {
    await cdp.send('Browser.setPermission', {
      origin: DEMO_ORIGIN,
      permission: name === 'push' ? { name, userVisibleOnly: true } : { name },
      setting: permission,
    })
  }
}

export async function openDemo(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Herald push test' })).toBeVisible()
  await expect(page.locator('#supported')).not.toHaveText('Checking…')
}

export async function enable(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Enable notifications' }).click()
  await expect(page.locator('#device')).not.toHaveText('Not registered', { timeout: PUSH_TIMEOUT })
  return (await page.locator('#device').textContent()) ?? ''
}

export type ShownNotification = { title: string; body: string; tag: string; link?: string }

export async function notifications(page: Page): Promise<ShownNotification[]> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return (await registration.getNotifications()).map((notification) => ({
      title: notification.title,
      body: notification.body,
      tag: notification.tag,
      link: (notification.data as { herald?: { link?: string } } | null)?.herald?.link,
    }))
  })
}

export function received(page: Page) {
  return page.getByRole('list', { name: 'Received deliveries' }).getByRole('listitem')
}

// Hands a payload to the service worker as if a push service delivered it.
// Used for cases Herald never sends, such as an already-expired message.
export async function injectPush(page: Page, payload: Delivery | Record<string, unknown>) {
  const cdp = await page.context().newCDPSession(page)
  const registrationId = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      // Registrations cleared by earlier tests are still reported, as deleted.
      const match = registrations.find(
        (registration) => registration.scopeURL === `${DEMO_ORIGIN}/` && !registration.isDeleted,
      )
      if (match) resolve(match.registrationId)
    })
  })
  await cdp.send('ServiceWorker.enable')
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: DEMO_ORIGIN,
    registrationId: await registrationId,
    data: JSON.stringify(payload),
  })
  await cdp.detach()
}

// Delivers the stored envelope of a published message to this page's device
// and waits until the service worker has handled it. Reading notifications
// while the worker is still showing one can lose it in headless Chrome.
export async function deliver(page: Page, messageId: string) {
  const deviceId = (await page.locator('#device').textContent()) ?? ''
  const stored = storedDelivery(messageId, deviceId)
  await injectPush(page, stored)
  await expect(received(page).filter({ hasText: stored.delivery_id }).first()).toBeVisible()
}

export function delivery(overrides: Partial<Delivery['message']> & { delivery_id?: string } = {}): Delivery {
  const { delivery_id = crypto.randomUUID(), ...message } = overrides
  return {
    delivery_id,
    sequence: 1,
    message: {
      id: crypto.randomUUID(),
      channel: 'alerts',
      priority: 'normal',
      title: 'Injected',
      body: 'Injected push',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      created_at: new Date().toISOString(),
      ...message,
    },
  }
}

export async function snap(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
}

export async function pushEndpoint(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
    return subscription?.endpoint ?? null
  })
}

// Edits the stored device state the way a stale or foreign install would
// leave it.
export async function editDeviceState(page: Page, patch: Record<string, string>) {
  await page.evaluate(async (patch) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('herald-web')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const store = db.transaction('state', 'readwrite').objectStore('state')
      store.get('device').onsuccess = (event) => {
        store.put({ ...(event.target as IDBRequest).result, ...patch }, 'device')
      }
      store.transaction.oncomplete = () => resolve()
      store.transaction.onerror = () => reject(store.transaction.error)
    })
    db.close()
  }, patch)
}

export async function dropPushSubscription(page: Page) {
  await page.evaluate(async () => {
    const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
    await subscription?.unsubscribe()
  })
}

// A Trusted Web Activity gives only its first page load an android-app://
// referrer. Chrome ignores such a referrer from a normal navigation, so the
// first load is marked with a query and the referrer is set for that load.
export async function launchFromAndroidApp(page: Page) {
  await page.addInitScript(() => {
    if (location.search !== '?launch=android') return
    Object.defineProperty(Document.prototype, 'referrer', { get: () => 'android-app://dev.omnific.demo/' })
  })
  await page.goto('/?launch=android')
  // Without a bridge the page waits for one before giving up.
  await expect(page.locator('#supported')).toHaveText('Android app', { timeout: 10_000 })
}

export type FakeBridge = {
  ready: { subscriptions: Subscription[]; saved?: boolean; notifications?: 'granted' | 'denied' }
  // The error code the APK answers every set with; omitted means success.
  error?: string
  // Opens the channel from another origin, to check it is ignored.
  origin?: string
}

// Plays the herald-android side of the subscription bridge. A real Trusted
// Web Activity cannot run here, so the APK is replaced by a MessageChannel
// that follows the same protocol and records every command it receives.
export async function installFakeBridge(page: Page, bridge: FakeBridge) {
  await page.addInitScript((bridge) => {
    const commands: unknown[] = []
    Object.assign(window, { heraldBridgeCommands: commands })
    window.addEventListener('load', () => {
      const channel = new MessageChannel()
      channel.port1.onmessage = (event) => {
        const command = JSON.parse(event.data as string)
        commands.push(command)
        const reply = bridge.error
          ? { type: 'herald.subscriptions.result', id: command.id, ok: false, error: bridge.error }
          : { type: 'herald.subscriptions.result', id: command.id, ok: true }
        channel.port1.postMessage(JSON.stringify(reply))
      }
      // As Chrome does: an empty message carries the port, then the APK's
      // first message arrives on it (PostMessageHandler.initializeWithWebContents),
      // from the verified host as an android-app origin
      // (OriginVerifier.getPostMessageUriFromVerifiedOrigin).
      const origin = bridge.origin ?? `android-app://${location.hostname}`
      window.dispatchEvent(new MessageEvent('message', { data: '', origin, ports: [channel.port2] }))
      channel.port1.postMessage(JSON.stringify({ type: 'herald.ready', ...bridge.ready }))
    })
  }, bridge)
}

export async function bridgeCommands(page: Page): Promise<{ type: string; subscriptions?: Subscription[] }[]> {
  return page.evaluate(() => (window as unknown as { heraldBridgeCommands: [] }).heraldBridgeCommands)
}
