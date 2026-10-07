import { onBeforeUnmount, onMounted } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'

const STORAGE_KEY = 'visual-regression-platform-v1'

/**
 * 监听其他浏览器窗口的写入：localStorage 的 storage 事件只在“其他”标签页触发，
 * 因此本窗口自己的写入仍走 TanStack Query 的主动失效，跨窗口变化走这里自动刷新。
 * 传入需要失效的查询 key 前缀（如 ['batches']、['rules']）。
 */
export const useCrossWindowSync = (prefixes: string[][]) => {
  const queryClient = useQueryClient()

  const handler = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    prefixes.forEach((prefix) => {
      void queryClient.invalidateQueries({ queryKey: prefix })
    })
  }

  onMounted(() => window.addEventListener('storage', handler))
  onBeforeUnmount(() => window.removeEventListener('storage', handler))
}
