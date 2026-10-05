import { enable, expect, launchFromAndroidApp, openDemo, pushEndpoint, snap, test } from './fixtures'
import { publish } from './harness'

test('inside an Android app without the bridge the page offers no controls', async ({ page }, testInfo) => {
  await launchFromAndroidApp(page)

  await expect(page.getByText('Notifications on this device are managed by the Android app')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeHidden()
  await expect(page.getByText('Add to Home Screen')).toBeHidden()
  await snap(page, testInfo, 'android-app')
})

test('the Android app is remembered for the rest of the session', async ({ page }) => {
  await launchFromAndroidApp(page)

  await page.goto('/')

  // Each load waits for a bridge before settling.
  await expect(page.locator('#supported')).toHaveText('Android app', { timeout: 10_000 })
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeHidden()
})

test('opening the Android app removes a web registration made in Chrome', async ({ page }) => {
  await openDemo(page)
  await enable(page)
  expect((await publish({ title: 'Before the app' })).device_count).toBe(1)

  await launchFromAndroidApp(page)

  await expect(page.locator('#device')).toHaveText('Not registered')
  expect(await pushEndpoint(page)).toBeNull()
  expect((await publish({ title: 'After the app' })).device_count).toBe(0)
})

test('a normal browser tab is not treated as the Android app', async ({ page }) => {
  await openDemo(page)

  await expect(page.locator('#supported')).toHaveText('Supported')
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeVisible()
})
