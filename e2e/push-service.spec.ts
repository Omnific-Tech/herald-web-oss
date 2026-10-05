import { enable, expect, notifications, openDemo, PUSH_TIMEOUT, received, snap, test } from './fixtures'
import { history, publish } from './harness'

// These go through the real push service, whose latency and occasional
// refusals are outside this suite's control.
test.describe.configure({ retries: 2 })

async function displayedCount(messageId: string) {
  return (await history()).find((message) => message.id === messageId)?.delivery_counts.displayed
}

test('a published message arrives through the real push service and is acknowledged', async ({ page }, testInfo) => {
  await openDemo(page)
  await enable(page)

  const published = await publish({ title: 'Real push', body: 'Sent by Herald through Web Push', link: '/events/1' })
  expect(published.device_count).toBe(1)

  await expect
    .poll(() => notifications(page), { timeout: PUSH_TIMEOUT })
    .toEqual([expect.objectContaining({ title: 'Real push', body: 'Sent by Herald through Web Push', link: '/events/1' })])
  await expect(received(page).first()).toContainText('displayed · ack 200')
  await expect.poll(() => displayedCount(published.message_id)).toBe(1)
  await snap(page, testInfo, 'received')
})

test('a push is handled with no page open', async ({ page }) => {
  await openDemo(page)
  await enable(page)
  await page.goto('about:blank')

  const published = await publish({ title: 'Background push' })

  await expect.poll(() => displayedCount(published.message_id), { timeout: PUSH_TIMEOUT }).toBe(1)
  await openDemo(page)
  expect((await notifications(page)).map((notification) => notification.title)).toContain('Background push')
})
