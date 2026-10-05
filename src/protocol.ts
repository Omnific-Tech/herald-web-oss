// Wire types for Herald protocol v1 (herald/docs/protocol-v1.md). Changing one
// side without the other breaks delivery silently.

export type Subscription = { channel: string; topic?: string }

export type DeliveryMessage = {
  id: string
  channel: string
  topic?: string
  priority: 'normal' | 'high'
  title: string
  body: string
  link?: string
  data?: unknown
  collapse_key?: string
  expires_at: string
  created_at: string
}

export type Delivery = { delivery_id: string; sequence: number; message: DeliveryMessage }

export type AckStatus = 'displayed' | 'suppressed'

export type RegisterResponse = {
  device_id: string
  install_id: string
  device_token: string
  acknowledged_sequence: number
}
