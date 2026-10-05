import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Delivery } from '../src/protocol'

export const HERALD_URL = 'http://localhost:8098'
export const DEMO_ORIGIN = 'http://localhost:4175'
export const ADMIN = { origin: 'http://admin.herald.test', username: 'e2e', password: 'e2e-password' }
export const STATE_FILE = resolve('.e2e/state.json')

export type HarnessState = { producerToken: string }

// A throwaway Postgres container started by global-setup.ts and removed after
// the run; queries never reach a shared database.
export const POSTGRES = { container: 'herald-web-e2e', port: 5435 }
export const DATABASE_URL = `postgres://herald:herald@localhost:${POSTGRES.port}/herald?sslmode=disable`

export function sql(statement: string): string {
  return execFileSync('docker', ['exec', POSTGRES.container, 'psql', '-U', 'herald', '-d', 'herald', '-qAt', '-c', statement], {
    encoding: 'utf8',
  }).trim()
}

export function harnessState(): HarnessState {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as HarnessState
}

export type HistoryMessage = {
  id: string
  title: string
  device_count: number
  delivery_counts: Record<string, number>
  delivery_errors: { state: string; reason: string; count: number }[]
}

let sessionCookie: string | undefined

async function adminCookie(): Promise<string> {
  if (sessionCookie) return sessionCookie
  const response = await fetch(`${HERALD_URL}/api/session`, {
    method: 'POST',
    headers: { Origin: ADMIN.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password }),
  })
  if (!response.ok) throw new Error(`admin sign-in failed: ${response.status}`)
  sessionCookie = response.headers.getSetCookie()[0].split(';')[0]
  return sessionCookie
}

export async function history(): Promise<HistoryMessage[]> {
  const response = await fetch(`${HERALD_URL}/api/applications/demo/messages?limit=100`, {
    headers: { Origin: ADMIN.origin, Cookie: await adminCookie() },
  })
  if (!response.ok) throw new Error(`history failed: ${response.status}`)
  return ((await response.json()) as { messages: HistoryMessage[] }).messages
}

export type Publish = {
  title: string
  body?: string
  channel?: string
  topic?: string
  link?: string
  collapse_key?: string
  expiresInSeconds?: number
}

export async function publish(message: Publish): Promise<{ message_id: string; device_count: number }> {
  const { expiresInSeconds = 600, ...fields } = message
  const response = await fetch(`${HERALD_URL}/v1/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${harnessState().producerToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      channel: 'alerts',
      body: 'Herald web push test',
      ...fields,
      expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    }),
  })
  if (response.status !== 202) throw new Error(`publish failed: ${response.status} ${await response.text()}`)
  return response.json() as Promise<{ message_id: string; device_count: number }>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// The envelope Herald stored for one device's delivery of a message, in the
// shape it sends. Lets a test hand the service worker a real delivery without
// waiting on the push service; push-service.spec.ts covers the real path.
export function storedDelivery(messageId: string, deviceId: string): Delivery {
  if (!UUID.test(messageId) || !UUID.test(deviceId)) throw new Error('expected message and device UUIDs')
  const query = `
    SELECT json_build_object(
      'delivery_id', d.id,
      'sequence', d.sequence,
      'message', json_strip_nulls(json_build_object(
        'id', m.id, 'channel', m.channel, 'topic', NULLIF(m.topic, ''),
        'priority', m.priority, 'title', m.title, 'body', m.body,
        'link', NULLIF(m.link, ''), 'data', m.data,
        'collapse_key', NULLIF(m.collapse_key, ''),
        'expires_at', m.expires_at, 'created_at', m.created_at)))
    FROM deliveries d JOIN messages m ON m.id = d.message_id
    WHERE m.id = '${messageId}' AND d.device_id = '${deviceId}'`
  const row = sql(query)
  if (!row) throw new Error(`no delivery of ${messageId} to ${deviceId}`)
  return JSON.parse(row) as Delivery
}
