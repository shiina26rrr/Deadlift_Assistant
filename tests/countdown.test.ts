import { describe, expect, it } from 'vitest'
import {
  COUNTDOWN_DEFAULT_SEC,
  COUNTDOWN_MAX_SEC,
  COUNTDOWN_MIN_SEC,
  validateCountdownSec
} from '@renderer/analysis/countdown'

describe('validateCountdownSec', () => {
  it('默认值为 6 秒，允许范围为 5–7 秒', () => {
    expect(COUNTDOWN_DEFAULT_SEC).toBe(6)
    expect(COUNTDOWN_MIN_SEC).toBe(5)
    expect(COUNTDOWN_MAX_SEC).toBe(7)
  })

  it('5/6/7 秒均通过', () => {
    for (const sec of [5, 6, 7]) {
      expect(validateCountdownSec(sec)).toEqual({ ok: true, seconds: sec })
    }
  })

  it('越界输入回落默认值且不静默截断到边界', () => {
    expect(validateCountdownSec(4)).toEqual({ ok: false, seconds: COUNTDOWN_DEFAULT_SEC })
    expect(validateCountdownSec(8)).toEqual({ ok: false, seconds: COUNTDOWN_DEFAULT_SEC })
    expect(validateCountdownSec(0)).toEqual({ ok: false, seconds: COUNTDOWN_DEFAULT_SEC })
    expect(validateCountdownSec(30)).toEqual({ ok: false, seconds: COUNTDOWN_DEFAULT_SEC })
  })

  it('非法输入（NaN/undefined/字符串）回落默认值', () => {
    expect(validateCountdownSec(Number.NaN)).toEqual({ ok: false, seconds: COUNTDOWN_DEFAULT_SEC })
    expect(validateCountdownSec(undefined)).toEqual({ ok: false, seconds: COUNTDOWN_DEFAULT_SEC })
    expect(validateCountdownSec('abc')).toEqual({ ok: false, seconds: COUNTDOWN_DEFAULT_SEC })
  })

  it('小数按四舍五入取整', () => {
    expect(validateCountdownSec(6.4)).toEqual({ ok: true, seconds: 6 })
    expect(validateCountdownSec(4.6)).toEqual({ ok: true, seconds: 5 })
    expect(validateCountdownSec(8.4)).toEqual({ ok: false, seconds: COUNTDOWN_DEFAULT_SEC })
  })

  it('数字字符串按数值处理', () => {
    expect(validateCountdownSec('7')).toEqual({ ok: true, seconds: 7 })
  })
})
