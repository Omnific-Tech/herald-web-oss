import { history, publish } from './harness'
import { deliver, delivery, enable, expect, injectPush, notifications, openDemo, received, snap, test } from './fixtures'

test('an expired message is not shown and is acknowledged as suppressed', async ({ page }, testInfo) => {
  await openDemo(page)
  await enable(page)

  await injectPush(page, delivery({ title: 'Too late', expires_at: new Date(Date.now() - 1000).toISOString() }))

  // The injected delivery ID is unknown to Herald, so the ack is sent and refused.
  await expect(received(page).first()).toContainText('suppressed · ack 404')
  expect(await notifications(page)).toEqual([])
  await snap(page, testInfo, 'suppressed')
})

test('a repeated delivery shows one notification and is acknowledged once', async ({ page }) => {
  await openDemo(page)
  await enable(page)
  const published = await publish({ title: 'Once only' })

  await deliver(page, published.message_id)
  await expect(received(page).filter({ hasText: 'displayed · ack 200' })).toHaveCount(1)
  await deliver(page, published.message_id)

  // The real push may also arrive; either way only one delivery is displayed.
  await expect(received(page).filter({ hasText: 'duplicate · no ack' }).first()).toBeVisible()
  await expect(received(page).filter({ hasText: 'displayed' })).toHaveCount(1)
  expect((await notifications(page)).map((notification) => notification.title)).toEqual(['Once only'])
  const counts = (await history()).find((message) => message.id === published.message_id)?.delivery_counts
  expect(counts?.displayed).toBe(1)
})

test('a push that is not a Herald delivery is left alone', async ({ page }) => {
  await openDemo(page)
  await enable(page)

  await injectPush(page, { kind: 'product-specific' })
  await injectPush(page, delivery({ title: 'Herald delivery' }))

  // The product payload produces neither an entry nor a notification.
  await expect(received(page)).toHaveCount(1)
  expect((await notifications(page)).map((notification) => notification.title)).toEqual(['Herald delivery'])
})
