import type { Subscription } from './protocol'

// Shared by the page and the service worker, which cannot read localStorage.
// The device token only authorizes this device's acks and subscriptions.
export type DeviceState = {
  heraldUrl: string
  application: string
  deviceId: string
  deviceToken: string
  endpoint: string
  subscriptions: Subscription[]
}

const DB_NAME = 'herald-web'
const STATE = 'state'
const SEEN = 'seen'
const DEVICE_KEY = 'device'
const SEEN_LIMIT = 500

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STATE)
      request.result.createObjectStore(SEEN).createIndex('at', 'at')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transact<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await open()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode)
      const request = run(transaction.objectStore(store))
      transaction.oncomplete = () => resolve(request ? request.result : undefined)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

export function readState(): Promise<DeviceState | undefined> {
  return transact<DeviceState>(STATE, 'readonly', (store) => store.get(DEVICE_KEY))
}

export async function writeState(state: DeviceState): Promise<void> {
  await transact(STATE, 'readwrite', (store) => store.put(state, DEVICE_KEY))
}

export async function clearState(): Promise<void> {
  await transact(STATE, 'readwrite', (store) => store.delete(DEVICE_KEY))
}

// Records a delivery ID and reports whether it was new. Delivery is
// at-least-once, so the same ID can arrive twice.
export async function markSeen(deliveryId: string): Promise<boolean> {
  const db = await open()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(SEEN, 'readwrite')
      const store = transaction.objectStore(SEEN)
      let fresh = false
      store.get(deliveryId).onsuccess = (event) => {
        if ((event.target as IDBRequest).result) return
        fresh = true
        store.put({ at: Date.now() }, deliveryId)
        store.count().onsuccess = (count) => {
          let excess = (count.target as IDBRequest<number>).result - SEEN_LIMIT
          if (excess <= 0) return
          store.index('at').openKeyCursor().onsuccess = (cursor) => {
            const current = (cursor.target as IDBRequest<IDBCursor | null>).result
            if (!current || excess-- <= 0) return
            store.delete(current.primaryKey)
            current.continue()
          }
        }
      }
      transaction.oncomplete = () => resolve(fresh)
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}
