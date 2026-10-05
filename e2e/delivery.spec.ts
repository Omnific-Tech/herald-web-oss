import type { Page } from '@playwright/test'
import {
  deliver,
  dropPushSubscription,
  editDeviceState,
  enable,
  expect,
  injectPush,
  notifications,
  openDemo,
  pushEndpoint,
  received,
  test,
} from './fixtures'
import { publish, storedDelivery } from './harness'

async function titles(page: Page) {
  return (await notifications(page)).map((notification) => notification.title)
}

test('a collapse key replaces the earlier notification', async ({ page }) => {
  await openDemo(page)
  await enable(page)

  const first = await publish({ title: 'Status: degraded', collapse_key: 'status' })
  await deliver(page, first.message_id)
  await expect.poll(() => titles(page)).toEqual(['Status: degraded'])

  const second = await publish({ title: 'Status: recovered', collapse_key: 'status' })
  await deliver(page, second.message_id)
  await expect.poll(() => titles(page)).toEqual(['Status: recovered'])
})

test('a late copy of an earlier message does not bring its notification back', async ({ page }) => {
  await openDemo(page)
  const deviceId = await enable(page)

  const first = await publish({ title: 'Status: degraded', collapse_key: 'status' })
  await deliver(page, first.message_id)
  const second = await publish({ title: 'Status: recovered', collapse_key: 'status' })
  await deliver(page, second.message_id)
  await expect.poll(() => titles(page)).toEqual(['Status: recovered'])

  // Push services may redeliver, and the real push may also arrive late.
  const late = storedDelivery(first.message_id, deviceId)
  const copies = received(page).filter({ hasText: `duplicate · no ack · ${late.delivery_id}` })
  const before = await copies.count()
  await injectPush(page, late)
  await expect(copies).toHaveCount(before + 1)
  expect(await titles(page)).toEqual(['Status: recovered'])
})

test('only subscribed channels are delivered', async ({ page }) => {
  await openDemo(page)
  await page.getByLabel('System').uncheck()
  await enable(page)

  expect((await publish({ title: 'System notice', channel: 'system' })).device_count).toBe(0)
  expect((await publish({ title: 'Alert', channel: 'alerts' })).device_count).toBe(1)
})

test('updating channels changes what is delivered', async ({ page }) => {
  await openDemo(page)
  const device = await enable(page)

  await page.getByLabel('Alerts').uncheck()
  await page.getByRole('button', { name: 'Update channels' }).click()
  await expect(page.getByRole('button', { name: 'Update channels' })).toBeEnabled()

  expect((await publish({ title: 'Alert', channel: 'alerts' })).device_count).toBe(0)
  expect((await publish({ title: 'System notice', channel: 'system' })).device_count).toBe(1)
  await page.reload()
  await expect(page.getByLabel('Alerts')).not.toBeChecked()
  await expect(page.locator('#device')).toHaveText(device)
})

test('disabling stops delivery and removes the push subscription', async ({ page }) => {
  await openDemo(page)
  await enable(page)

  await page.getByRole('button', { name: 'Disable' }).click()

  await expect(page.locator('#device')).toHaveText('Not registered')
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeVisible()
  expect(await pushEndpoint(page)).toBeNull()
  expect((await publish({ title: 'After disable' })).device_count).toBe(0)
})

test('a dropped push subscription is replaced on the next visit, keeping the device', async ({ page }) => {
  await openDemo(page)
  const device = await enable(page)
  const endpoint = await pushEndpoint(page)

  await dropPushSubscription(page)
  await page.reload()

  await expect.poll(() => pushEndpoint(page), { timeout: 60_000 }).not.toBeNull()
  expect(await pushEndpoint(page)).not.toBe(endpoint)
  await expect(page.locator('#device')).toHaveText(device)
  const published = await publish({ title: 'After resubscribe' })
  expect(published.device_count).toBe(1)
  await deliver(page, published.message_id)
  await expect.poll(() => titles(page)).toContain('After resubscribe')
})

test('a device Herald no longer accepts registers again', async ({ page }) => {
  await openDemo(page)
  const device = await enable(page)

  await editDeviceState(page, { deviceToken: 'revoked-token' })
  await dropPushSubscription(page)
  await page.reload()

  await expect(page.locator('#device')).not.toHaveText(device, { timeout: 60_000 })
  await expect(page.locator('#device')).not.toHaveText('Not registered')
  const published = await publish({ title: 'New device' })
  await deliver(page, published.message_id)
  await expect.poll(() => titles(page)).toContain('New device')
})
