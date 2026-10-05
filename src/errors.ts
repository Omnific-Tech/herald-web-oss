export type HeraldErrorCode =
  | 'unsupported'
  | 'android_app'
  | 'permission_denied'
  | 'push_unavailable'
  | 'not_enabled'
  | 'invalid_subscriptions'
  | 'request_failed'

export class HeraldError extends Error {
  readonly code: HeraldErrorCode
  readonly status?: number

  constructor(code: HeraldErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'HeraldError'
    this.code = code
    this.status = status
  }
}
