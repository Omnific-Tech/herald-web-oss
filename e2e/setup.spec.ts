import { createECDH } from 'node:crypto'
import { enable, expect, openDemo, pushEndpoint, snap, test } from './fixtures'
import { HERALD_URL, publish } from './harness'

test.describe('permission denied', () => {
  test.use({ permission: 'denied' })

  test('explains the refusal and registers nothing', async ({ page }, testInfo) => {
    await openDemo(page)

    await page.getByRole('button', { name: 'Enable notifications' }).click()

    await expect(page.getByRole('alert')).toHaveText('Notification permission was not granted.')
    await expect(page.locator('#device')).toHaveText('Not registered')
    expect(await pushEndpoint(page)).toBeNull()
    await snap(page, testInfo, 'denied')
  })
})

test('a browser without Web Push explains how to install on iPhone', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    delete (window as { PushManager?: unknown }).PushManager
  })
  await openDemo(page)

  await expect(page.locator('#supported')).toHaveText('Not supported')
  await expect(page.getByText('Add to Home Screen')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeHidden()
  await snap(page, testInfo, 'unsupported')
})

test('an unknown application creates no push subscription', async ({ page }) => {
  await page.route(`${HERALD_URL}/v1/applications/demo/vapid-public-key`, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'application not found' }),
    }),
  )
  await openDemo(page)

  await page.getByRole('button', { name: 'Enable notifications' }).click()

  await expect(page.getByRole('alert')).toHaveText('application not found')
  expect(await pushEndpoint(page)).toBeNull()
})

test('a failed registration stores nothing and can be retried', async ({ page }) => {
  await page.route(`${HERALD_URL}/v1/devices/register`, (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'internal server error' }),
    }),
  )
  await openDemo(page)
  await page.getByRole('button', { name: 'Enable notifications' }).click()
  await expect(page.getByRole('alert')).toHaveText('internal server error', { timeout: 45_000 })
  await page.reload()
  await expect(page.locator('#device')).toHaveText('Not registered')

  await page.unroute(`${HERALD_URL}/v1/devices/register`)
  await enable(page)
  expect((await publish({ title: 'After retry' })).device_count).toBe(1)
})

test('a push subscription made with another key is replaced', async ({ page }) => {
  const foreign = createECDH('prime256v1')
  foreign.generateKeys()
  await openDemo(page)
  const staleEndpoint = await page.evaluate(async (key) => {
    const registration = await navigator.serviceWorker.ready
    return (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })).endpoint
  }, foreign.getPublicKey().toString('base64url'))

  await enable(page)

  expect(await pushEndpoint(page)).not.toBe(staleEndpoint)
  const key = await page.evaluate(async () => {
    const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
    const bytes = new Uint8Array(subscription?.options.applicationServerKey ?? new ArrayBuffer(0))
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  })
  const herald = (await (await fetch(`${HERALD_URL}/v1/applications/demo/vapid-public-key`)).json()) as { public_key: string }
  expect(key).toBe(herald.public_key)
})

test('a push service refusal is reported and registers nothing', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    PushManager.prototype.subscribe = () =>
      Promise.reject(new DOMException('Registration failed - push service error', 'AbortError'))
  })
  await openDemo(page)

  await page.getByRole('button', { name: 'Enable notifications' }).click()

  await expect(page.getByRole('alert')).toHaveText(
    "The browser's push service refused the subscription (Registration failed - push service error).",
  )
  await expect(page.locator('#device')).toHaveText('Not registered')
  await snap(page, testInfo, 'push-unavailable')
})
