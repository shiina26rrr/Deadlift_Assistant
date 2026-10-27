// 校准后倒计时参数校验（v3）：默认 6 秒，可设 5–7 秒；越界/非法回落默认值。
// 参考状态（calibrated）、倒计时状态（countdownActive）与组状态（setActive）在控制器中分开管理，
// 倒计时使用单一定时器，取消/失效时统一清理，不留过期定时器。

/** 默认倒计时秒数（v3：3 → 6）。 */
export const COUNTDOWN_DEFAULT_SEC = 6
/** 允许设置的倒计时下限（秒）。 */
export const COUNTDOWN_MIN_SEC = 5
/** 允许设置的倒计时上限（秒）。 */
export const COUNTDOWN_MAX_SEC = 7

export interface CountdownValidation {
  /** 输入是否在允许范围内（5–7）。 */
  ok: boolean
  /** 实际采用的秒数：合法时为输入值，越界/非法时回落默认值。 */
  seconds: number
}

/**
 * 校验倒计时秒数：仅接受 5–7 的整数；NaN/越界等非法输入回落默认 6 秒。
 * 越界不会被静默截断到边界，而是回到默认值，避免用户以为设置已生效。
 */
export function validateCountdownSec(input: unknown): CountdownValidation {
  const n = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(n)) return { ok: false, seconds: COUNTDOWN_DEFAULT_SEC }
  const sec = Math.round(n)
  if (sec < COUNTDOWN_MIN_SEC || sec > COUNTDOWN_MAX_SEC) {
    return { ok: false, seconds: COUNTDOWN_DEFAULT_SEC }
  }
  return { ok: true, seconds: sec }
}
