import { bridgeState, listenForBridge, setBridgeSubscriptions } from './bridge'
import { HeraldError } from './errors'
import type { RegisterResponse, Subscription } from './protocol'
import { clearState, readState, writeState, type DeviceState } from './store'

export { HeraldError, type HeraldErrorCode } from './errors'
export type { Delivery, DeliveryMessage, Subscription } from './protocol'

export type HeraldOptions = {
  heraldUrl: string
  application: string
  // Defaults to navigator.serviceWorker.ready.
  registration?: () => Promise<ServiceWorkerRegistration>
}

export type EnableOptions = {
  subscriptions: Subscription[]
  displayName?: string
}

// 'android_app': the page runs inside a herald-android product APK. The APK
// delivers natively (Web Push there would notify twice), and subscriptions
// go through its bridge when it offers one.
export type HeraldEnvironment = 'supported' | 'android_app' | 'unsupported'

export type HeraldStatus = {
  environment: HeraldEnvironment
  supported: boolean
  permission: NotificationPermission | 'unsupported'
  enabled: boolean
  // Whether the user has chosen subscriptions on this device. Inside the
  // Android app, false means the APK is still on its default set.
  saved: boolean
  deviceId?: string
  subscriptions: Subscription[]
}

const ANDROID_APP_KEY = 'herald-web:android-app'

// A Trusted Web Activity opens the page with an android-app:// referrer, but
// only on its first load, so the result is kept for the tab's session. Chrome
// shares storage between the app and the browser, which rules out anything
// longer-lived than sessionStorage.
export function isAndroidApp(): boolean {
  if (typeof document === 'undefined') return false
  try {
    if (document.referrer.startsWith('android-app://')) sessionStorage.setItem(ANDROID_APP_KEY, '1')
    return sessionStorage.getItem(ANDROID_APP_KEY) === '1'
  } catch {
    return document.referrer.startsWith('android-app://')
  }
}

if (isAndroidApp()) listenForBridge()

export function environment(): HeraldEnvironment {
  if (isAndroidApp()) return 'android_app'
  // iPhone and iPad expose PushManager only to a PWA opened from the Home Screen.
  const available =
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  return available ? 'supported' : 'unsupported'
}

export function isSupported(): boolean {
  return environment() === 'supported'
}

export function createHerald(options: HeraldOptions) {
  const heraldUrl = options.heraldUrl.replace(/\/+$/, '')
  const registration = options.registration ?? (() => navigator.serviceWorker.ready)

  async function request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    let response: Response
    try {
      response = await fetch(`${heraldUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new HeraldError('request_failed', 'Herald could not be reached.')
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      throw new HeraldError('request_failed', payload.error ?? `Herald returned ${response.status}.`, response.status)
    }
    return (response.status === 204 ? undefined : await response.json()) as T
  }

  // Ignores state written for another Herald or application on the same origin.
  async function ownState(): Promise<DeviceState | undefined> {
    const state = await readState()
    return state?.heraldUrl === heraldUrl && state.application === options.application ? state : undefined
  }

  async function publicKey(): Promise<string> {
    const response = await request<{ public_key: string }>(
      'GET',
      `/v1/applications/${encodeURIComponent(options.application)}/vapid-public-key`,
    )
    return response.public_key
  }

  // A PushSubscription is pinned to the key it was created with, so one made
  // with a rotated or foreign key has to be replaced.
  async function pushSubscription(key: string): Promise<PushSubscription> {
    const pushManager = (await registration()).pushManager
    const existing = await pushManager.getSubscription()
    if (existing && sameKey(existing.options.applicationServerKey, key)) return existing
    await existing?.unsubscribe()
    try {
      return await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    } catch (error) {
      // Brave, for one, disables its push service by default.
      const detail = error instanceof Error ? ` (${error.message})` : ''
      throw new HeraldError('push_unavailable', `The browser's push service refused the subscription${detail}.`)
    }
  }

  async function register(
    subscription: PushSubscription,
    previous: DeviceState | undefined,
    displayName: string,
  ): Promise<RegisterResponse> {
    const json = subscription.toJSON()
    const body = {
      application: options.application,
      platform: 'web',
      display_name: displayName,
      webpush: { endpoint: subscription.endpoint, p256dh: json.keys?.p256dh, auth: json.keys?.auth },
    }
    if (previous) {
      try {
        return await request<RegisterResponse>('POST', '/v1/devices/register', body, previous.deviceToken)
      } catch (error) {
        // The device no longer exists in Herald; register a new one.
        if (!(error instanceof HeraldError && error.status === 401)) throw error
      }
    }
    return request<RegisterResponse>('POST', '/v1/devices/register', body)
  }

  async function connect(subscriptions: Subscription[], displayName: string): Promise<DeviceState> {
    const previous = await ownState()
    const subscription = await pushSubscription(await publicKey())
    const device = await register(subscription, previous, displayName)
    const state: DeviceState = {
      heraldUrl,
      application: options.application,
      deviceId: device.device_id,
      deviceToken: device.device_token,
      endpoint: subscription.endpoint,
      subscriptions: previous?.subscriptions ?? [],
    }
    await writeState(state)
    // A rotation keeps the server-side set; a new device starts empty.
    if (previous?.deviceId !== device.device_id || !sameSubscriptions(state.subscriptions, subscriptions)) {
      await putSubscriptions(state, subscriptions)
    }
    return state
  }

  async function putSubscriptions(state: DeviceState, subscriptions: Subscription[]) {
    await request('PUT', '/v1/subscriptions', { subscriptions }, state.deviceToken)
    await writeState({ ...state, subscriptions })
  }

  // Herald keeps the device record; an empty subscription set stops fan-out.
  async function disableWebPush(): Promise<void> {
    const state = await ownState()
    if (state) {
      await request('PUT', '/v1/subscriptions', { subscriptions: [] }, state.deviceToken).catch(() => {})
      await clearState()
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    const subscription = await (await registration()).pushManager.getSubscription()
    await subscription?.unsubscribe()
  }

  async function status(): Promise<HeraldStatus> {
    const current = environment()
    if (current === 'android_app') {
      const bridge = await bridgeState()
      if (!bridge) return offline(current)
      return {
        environment: current,
        supported: true,
        permission: bridge.notifications,
        enabled: bridge.notifications === 'granted' && bridge.subscriptions.length > 0,
        saved: bridge.saved,
        subscriptions: bridge.subscriptions,
      }
    }
    if (current !== 'supported') return offline(current)
    const state = await ownState()
    return {
      environment: current,
      supported: true,
      permission: Notification.permission,
      enabled: Boolean(state) && Notification.permission === 'granted',
      saved: Boolean(state),
      deviceId: state?.deviceId,
      subscriptions: state?.subscriptions ?? [],
    }
  }

  return {
    status,

    // Call from a user gesture: browsers block or permanently deny a
    // permission prompt that is not.
    async enable({ subscriptions, displayName = defaultDisplayName() }: EnableOptions): Promise<void> {
      if (isAndroidApp()) return setBridgeSubscriptions(subscriptions)
      if (!isSupported()) throw new HeraldError('unsupported', 'This browser does not support Web Push.')
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        throw new HeraldError('permission_denied', 'Notification permission was not granted.')
      }
      await connect(subscriptions, displayName)
    },

    // Call on each page load. Re-registers when the browser replaced or
    // dropped the push subscription. Inside the Android app it removes a web
    // registration made earlier in Chrome on the same phone, since the app
    // already delivers there. Returns whether notifications are on.
    async sync(): Promise<boolean> {
      if (isAndroidApp()) {
        if (await ownState()) await disableWebPush()
        return (await status()).enabled
      }
      if (!isSupported() || Notification.permission !== 'granted') return false
      const state = await ownState()
      if (!state) return false
      const current = await (await registration()).pushManager.getSubscription()
      if (current?.endpoint === state.endpoint) return true
      await connect(state.subscriptions, defaultDisplayName())
      return true
    },

    async setSubscriptions(subscriptions: Subscription[]): Promise<void> {
      if (isAndroidApp()) return setBridgeSubscriptions(subscriptions)
      const state = await ownState()
      if (!state) throw new HeraldError('not_enabled', 'Notifications are not enabled on this device.')
      await putSubscriptions(state, subscriptions)
    },

    // Inside the Android app this empties the APK's subscription set.
    async disable(): Promise<void> {
      if (isAndroidApp()) return setBridgeSubscriptions([])
      await disableWebPush()
    },
  }
}

function offline(environment: HeraldEnvironment): HeraldStatus {
  return { environment, supported: false, permission: 'unsupported', enabled: false, saved: false, subscriptions: [] }
}

export type Herald = ReturnType<typeof createHerald>

function defaultDisplayName(): string {
  return navigator.userAgent.slice(0, 200)
}

function sameKey(current: ArrayBuffer | null, key: string): boolean {
  if (!current) return false
  const expected = base64UrlBytes(key)
  const actual = new Uint8Array(current)
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index])
}

function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
}

function sameSubscriptions(a: Subscription[], b: Subscription[]): boolean {
  const key = (list: Subscription[]) =>
    list
      .map((entry) => `${entry.channel}\u0000${entry.topic ?? ''}`)
      .sort()
      .join('\u0001')
  return key(a) === key(b)
}
