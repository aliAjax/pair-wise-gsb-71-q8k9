import { ref } from 'vue'
import { heartbeat, releaseLock } from '@/api/http'
import type { LockPayload } from '@/types'

/**
 * 每个浏览器窗口（标签页）一个稳定身份，存在 sessionStorage：
 * 同窗口内路由切换不换身份；新开标签页会得到不同窗口，用来演示写锁与草稿。
 */
const SESSION_KEY = 'vr-window-identity'

interface WindowIdentity {
  windowId: string
  label: string
}

const makeIdentity = (): WindowIdentity => {
  const rand = Math.random().toString(36).slice(2, 6)
  return { windowId: `win-${Date.now().toString(36)}-${rand}`, label: `窗口 ${rand.toUpperCase()}` }
}

const restore = (): WindowIdentity => {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as WindowIdentity
      if (parsed.windowId && parsed.label) return parsed
    }
  } catch {
    /* 忽略损坏的本地数据 */
  }
  const identity = makeIdentity()
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(identity))
  return identity
}

const identity = restore()

export const windowId = ref(identity.windowId)
export const windowLabel = ref(identity.label)

export const lockPayload = (): LockPayload => ({
  windowId: windowId.value,
  windowLabel: windowLabel.value,
})

/** 持锁期间的心跳定时器表：离开批次页时统一释放。 */
const timers = new Map<string, ReturnType<typeof setInterval>>()

export const startHeartbeat = (batchId: string): void => {
  stopHeartbeat(batchId)
  const timer = setInterval(() => {
    void heartbeat(batchId, lockPayload()).catch(() => undefined)
  }, 5000)
  timers.set(batchId, timer)
}

export const stopHeartbeat = (batchId: string): void => {
  const timer = timers.get(batchId)
  if (timer) {
    clearInterval(timer)
    timers.delete(batchId)
  }
}

export const releaseBatch = async (batchId: string): Promise<void> => {
  stopHeartbeat(batchId)
  try {
    await releaseLock(batchId, lockPayload())
  } catch {
    /* 锁可能已过期，忽略 */
  }
}
