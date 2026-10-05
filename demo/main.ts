import { createHerald, HeraldError, type Subscription } from '../src/index'
import type { HeraldWorkerMessage } from '../src/sw'

const heraldUrl = import.meta.env.VITE_HERALD_URL
const application = import.meta.env.VITE_HERALD_APPLICATION

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const form = element<HTMLFormElement>('controls')
const enableButton = element<HTMLButtonElement>('enable')
const disableButton = element<HTMLButtonElement>('disable')
const error = element('error')

element('target').textContent = `${heraldUrl} · ${application}`

const registration = 'serviceWorker' in navigator ? navigator.serviceWorker.register('/sw.js') : undefined
const herald = createHerald({
  heraldUrl,
  application,
  registration: async () => {
    await registration
    return navigator.serviceWorker.ready
  },
})

function selectedSubscriptions(): Subscription[] {
  return [...form.querySelectorAll<HTMLInputElement>('input[name=channel]:checked')].map((input) => ({
    channel: input.value,
  }))
}

async function render() {
  const status = await herald.status()
  element('supported').textContent = {
    supported: 'Supported',
    android_app: 'Android app',
    unsupported: 'Not supported',
  }[status.environment]
  element('permission').textContent = status.permission
  element('device').textContent =
    status.environment === 'android_app' && status.supported ? 'Android app' : (status.deviceId ?? 'Not registered')
  // Inside the APK without its bridge there is nothing the page can change.
  element('android-app').hidden = status.environment !== 'android_app' || status.supported
  element('unsupported').hidden = status.environment !== 'unsupported'
  form.hidden = !status.supported
  enableButton.textContent = status.enabled ? 'Update channels' : 'Enable notifications'
  disableButton.disabled = !status.enabled
  if (status.enabled || status.saved) {
    const channels = new Set(status.subscriptions.map((subscription) => subscription.channel))
    for (const input of form.querySelectorAll<HTMLInputElement>('input[name=channel]')) {
      input.checked = channels.has(input.value)
    }
  }
}

async function run(action: () => Promise<unknown>) {
  error.textContent = ''
  enableButton.disabled = true
  try {
    await action()
  } catch (cause) {
    error.textContent = cause instanceof HeraldError ? cause.message : 'Something went wrong.'
  } finally {
    enableButton.disabled = false
    await render()
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  void run(async () => {
    const status = await herald.status()
    if (status.enabled) await herald.setSubscriptions(selectedSubscriptions())
    else await herald.enable({ subscriptions: selectedSubscriptions() })
  })
})

disableButton.addEventListener('click', () => void run(() => herald.disable()))

navigator.serviceWorker?.addEventListener('message', (event: MessageEvent<HeraldWorkerMessage>) => {
  if (event.data?.type !== 'herald:delivery') return
  element('empty').hidden = true
  const item = document.createElement('li')
  const ack = event.data.ack === undefined ? 'no ack' : `ack ${event.data.ack}`
  item.textContent = `${new Date().toLocaleTimeString()} ${event.data.outcome} · ${ack} · ${event.data.deliveryId}`
  element('received').prepend(item)
})

void run(() => herald.sync())
