import { computed, onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import {
  acquireBatchLock,
  releaseBatchLock,
  type BatchDetail,
} from '@/api/http'
import { getWindowId, windowLabel } from '@/utils/evidence'

/**
 * 批次跨窗口单写锁：
 * - 打开批次时尝试获取锁，获取不到则本窗口只读 + 可存草稿；
 * - 持锁期间定时续租，关闭页面时主动释放；
 * - 其他窗口释放（TTL 过期）后，本窗口轮询到空锁可接管。
 */
export const useBatchLock = (
  batchId: MaybeRefOrGetter<string | undefined>,
  batch: MaybeRefOrGetter<BatchDetail | undefined>,
) => {
  const getId = () => toValue(batchId)
  const getBatch = () => toValue(batch)
  const windowId = getWindowId()
  const label = windowLabel(windowId)
  const lockHolder = ref<BatchDetail['lock']>(null)
  const acquiring = ref(false)
  let heartbeat: number | undefined

  const isHolder = computed(
    () =>
      lockHolder.value?.windowId === windowId ||
      getBatch()?.lock?.windowId === windowId,
  )
  const holderLabel = computed(
    () => lockHolder.value?.windowLabel ?? getBatch()?.lock?.windowLabel ?? '其他窗口',
  )

  const refreshFromBatch = () => {
    lockHolder.value = getBatch()?.lock ?? null
  }

  const acquire = async () => {
    const id = getId()
    if (!id) return
    acquiring.value = true
    try {
      const result = await acquireBatchLock(id, { windowId, windowLabel: label })
      lockHolder.value = result.lock
    } catch {
      refreshFromBatch()
    } finally {
      acquiring.value = false
    }
  }

  const release = async () => {
    const id = getId()
    if (!id) return
    try {
      await releaseBatchLock(id, windowId)
    } finally {
      lockHolder.value = null
    }
  }

  watch(
    getId,
    async (id) => {
      if (!id) return
      refreshFromBatch()
      // 锁未被其他窗口持有时直接获取
      const current = getBatch()?.lock
      if (!current || current.windowId === windowId) await acquire()
    },
    { immediate: true },
  )

  // 续租 + 探测其他窗口是否已释放
  heartbeat = window.setInterval(() => {
    const id = getId()
    if (!id) return
    if (isHolder.value) void acquire()
    else if (!getBatch()?.lock) void acquire()
  }, 8_000)

  window.addEventListener('beforeunload', () => {
    const id = getId()
    if (id && isHolder.value) {
      void releaseBatchLock(id, windowId)
    }
  })

  onBeforeUnmount(() => {
    if (heartbeat) window.clearInterval(heartbeat)
    if (isHolder.value) void release()
  })

  return {
    windowId,
    windowLabel: label,
    lockHolder,
    isHolder,
    holderLabel,
    acquiring,
    acquire,
    release,
  }
}
