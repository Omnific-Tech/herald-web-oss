import { HeraldError } from './errors'
import type { Subscription } from './protocol'

// Client for the herald-android subscription bridge: JSON strings over the
// Trusted Web Activity postMessage channel. The APK keeps the device token;
// the page only reads and replaces the subscription set.
//
//   APK  -> page  {"type":"herald.ready","subscriptions":[…],"saved":bool,"notifications":"granted"|"denied"}
//   page -> APK   {"type":"herald.subscriptions.get","id":"…"}
//   page -> APK   {"type":"herald.subscriptions.set","id":"…","subscriptions":[…]}
//   APK  -> page  {"type":"herald.subscriptions.result","id":"…","ok":bool,"error"?:…,"subscriptions"?:[…]}
//
// Chrome opens the channel with an empty window message from origin
// android-app://<host> carrying a MessagePort; every APK message, herald.ready
// first, then arrives on that port. Chrome opens a new channel after every
// full navigation.

export type BridgeState = {
  subscriptions: Subscription[]
  // False until the user has chosen; the APK then reports its default set.
  saved: boolean
  notifications: 'granted' | 'denied'
}

type Ready = { type: 'herald.ready'; subscriptions?: Subscription[]; saved?: boolean; notifications?: string }
type Result = { type: 'herald.subscriptions.result'; id: string; ok: boolean; error?: string; subscriptions?: Subscription[] }

const READY_TIMEOUT = 5_000
const REPLY_TIMEOUT = 15_000

let port: MessagePort | undefined
let state: BridgeState | undefined
let listening = false
// When the page finished loading; the APK asks for the channel only then.
let loadedAt: Promise<number> | undefined
const readyWaiters = new Set<() => void>()
const pending = new Map<string, (result: Result) => void>()

function parse(data: unknown): Ready | Result | undefined {
  try {
    const value = typeof data === 'string' ? JSON.parse(data) : data
    if (value?.type === 'herald.ready' || value?.type === 'herald.subscriptions.result') return value
  } catch {
    // not a bridge message
  }
  return undefined
}

function accept(ready: Ready) {
  state = {
    subscriptions: ready.subscriptions ?? [],
    // APKs that predate these fields always had a saved or default set and
    // requested notification permission before launch.
    saved: ready.saved ?? true,
    notifications: ready.notifications === 'denied' ? 'denied' : 'granted',
  }
  for (const wake of readyWaiters) wake()
  readyWaiters.clear()
}

function receive(message: Ready | Result | undefined) {
  if (message?.type === 'herald.ready') accept(message)
  if (message?.type === 'herald.subscriptions.result') pending.get(message.id)?.(message)
}

// Must run before the APK's first message, which is sent once the page has
// loaded; index.ts calls it on import inside the Android app.
export function listenForBridge() {
  if (listening || typeof window === 'undefined') return
  listening = true
  loadedAt =
    document.readyState === 'complete'
      ? Promise.resolve(Date.now())
      : new Promise((resolve) => window.addEventListener('load', () => resolve(Date.now()), { once: true }))
  window.addEventListener('message', (event) => {
    // Chrome opens the channel only after verifying the APK's use_as_origin
    // link, and posts as android-app://<verified host>; no web page can.
    if (event.origin !== `android-app://${window.location.hostname}` || !event.ports[0]) return
    port = event.ports[0]
    port.onmessage = (portEvent) => receive(parse(portEvent.data))
    receive(parse(event.data))
  })
}

// Resolves undefined when no bridge answers within the timeout, counted from
// the page's load event: the APK has it disabled, or the phone's browser
// cannot open the app as a Trusted Web Activity. A later ready message still
// takes effect.
export async function bridgeState(timeout = READY_TIMEOUT): Promise<BridgeState | undefined> {
  if (state) return state
  const since = await (loadedAt ?? Date.now())
  if (state) return state
  const remaining = since + timeout - Date.now()
  if (remaining <= 0) return undefined
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, remaining)
    function done() {
      clearTimeout(timer)
      readyWaiters.delete(done)
      resolve()
    }
    readyWaiters.add(done)
  })
  return state
}

async function command(body: Record<string, unknown>): Promise<Result> {
  if (!(await bridgeState()) || !port) {
    throw new HeraldError('android_app', 'Notifications on this device are managed by the Android app.')
  }
  const id = crypto.randomUUID()
  const reply = new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new HeraldError('request_failed', 'The Android app did not respond.'))
    }, REPLY_TIMEOUT)
    pending.set(id, (result) => {
      clearTimeout(timer)
      pending.delete(id)
      resolve(result)
    })
  })
  port.postMessage(JSON.stringify({ ...body, id }))
  return reply
}

export async function setBridgeSubscriptions(subscriptions: Subscription[]): Promise<void> {
  const result = await command({ type: 'herald.subscriptions.set', subscriptions })
  if (result.ok) {
    if (state) state = { ...state, subscriptions, saved: true }
    return
  }
  switch (result.error) {
    case 'invalid_subscriptions':
      throw new HeraldError('invalid_subscriptions', 'The Android app rejected these subscriptions.')
    case 'notifications_denied':
      throw new HeraldError('permission_denied', 'Notifications are turned off for the Android app.')
    default:
      throw new HeraldError('request_failed', 'The Android app could not reach Herald.')
  }
}
