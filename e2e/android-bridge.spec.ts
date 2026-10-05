import { bridgeCommands, expect, installFakeBridge, launchFromAndroidApp, snap, test } from './fixtures'

test('inside the app, channels are read from and saved through the bridge', async ({ page }, testInfo) => {
  await installFakeBridge(page, { ready: { subscriptions: [{ channel: 'alerts' }], saved: true, notifications: 'granted' } })
  await launchFromAndroidApp(page)

  await expect(page.locator('#device')).toHaveText('Android app')
  await expect(page.getByLabel('Alerts')).toBeChecked()
  await expect(page.getByLabel('System')).not.toBeChecked()
  await snap(page, testInfo, 'android-bridge')

  await page.getByLabel('System').check()
  await page.getByRole('button', { name: 'Update channels' }).click()

  await expect.poll(() => bridgeCommands(page)).toEqual([
    expect.objectContaining({
      type: 'herald.subscriptions.set',
      subscriptions: [{ channel: 'alerts' }, { channel: 'system' }],
    }),
  ])
  await expect(page.getByRole('alert')).toHaveText('')
})

test('a bridge that opens after a slow page load still connects', async ({ page }) => {
  // The APK asks for the channel only once the page has fully loaded.
  await page.route('**/slow-asset.png', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 7_000))
    await route.fulfill({ contentType: 'image/png', body: Buffer.alloc(0) })
  })
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const image = new Image()
      image.src = '/slow-asset.png'
      document.body.append(image)
    })
  })
  await installFakeBridge(page, { ready: { subscriptions: [{ channel: 'alerts' }], saved: true } })
  await launchFromAndroidApp(page)

  await expect(page.locator('#device')).toHaveText('Android app')
  await expect(page.getByLabel('Alerts')).toBeChecked()
})

test('the APK default set is shown until the user chooses', async ({ page }) => {
  await installFakeBridge(page, {
    ready: { subscriptions: [{ channel: 'alerts' }, { channel: 'system' }], saved: false },
  })
  await launchFromAndroidApp(page)

  await expect(page.getByLabel('Alerts')).toBeChecked()
  await expect(page.getByLabel('System')).toBeChecked()
  expect(await bridgeCommands(page)).toEqual([])
})

test('disabling empties the APK subscription set', async ({ page }) => {
  await installFakeBridge(page, { ready: { subscriptions: [{ channel: 'alerts' }], saved: true } })
  await launchFromAndroidApp(page)

  await page.getByRole('button', { name: 'Disable' }).click()

  await expect.poll(() => bridgeCommands(page)).toEqual([
    expect.objectContaining({ type: 'herald.subscriptions.set', subscriptions: [] }),
  ])
})

test('a set the APK rejects is reported', async ({ page }) => {
  await installFakeBridge(page, {
    ready: { subscriptions: [{ channel: 'alerts' }], saved: true },
    error: 'invalid_subscriptions',
  })
  await launchFromAndroidApp(page)

  await page.getByRole('button', { name: 'Update channels' }).click()

  await expect(page.getByRole('alert')).toHaveText('The Android app rejected these subscriptions.')
})

test('notifications turned off for the app are reported', async ({ page }) => {
  await installFakeBridge(page, {
    ready: { subscriptions: [{ channel: 'alerts' }], saved: true, notifications: 'denied' },
    error: 'notifications_denied',
  })
  await launchFromAndroidApp(page)

  await expect(page.locator('#permission')).toHaveText('denied')
  await page.getByRole('button', { name: 'Enable notifications' }).click()

  await expect(page.getByRole('alert')).toHaveText('Notifications are turned off for the Android app.')
})

test('a ready message from another origin is ignored', async ({ page }) => {
  await installFakeBridge(page, {
    ready: { subscriptions: [{ channel: 'alerts' }], saved: true },
    origin: 'https://attacker.example',
  })
  await launchFromAndroidApp(page)

  await expect(page.getByText('Notifications on this device are managed by the Android app')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Update channels' })).toBeHidden()
})
