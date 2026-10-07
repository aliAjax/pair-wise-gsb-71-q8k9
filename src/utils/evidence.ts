import type { DifferenceRegion, IgnoreRule, ScreenshotRun } from '@/types'

/**
 * 简易稳定字符串哈希（djb2 变种），用于给截图内容、差异区域生成指纹。
 * 指纹只用于“内容是否变化”的前后对比，不承担加密职责。
 */
export const stableHash = (input: string): string => {
  let hash = 5381
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index)
  }
  // 转为无符号 36 进制，保持简短可读
  return (hash >>> 0).toString(36).padStart(7, '0')
}

/** 当前图指纹：优先使用上传图内容，缺省时由运行差异事实推导 */
export const runImageFingerprint = (run: ScreenshotRun): string => {
  if (run.imageFingerprint) return run.imageFingerprint
  if (run.currentImage) {
    return `img-${stableHash(run.currentImage)}`
  }
  return `img-${stableHash(
    JSON.stringify({
      v: run.currentVersion,
      b: run.build,
      m: run.mismatchRate,
      c: run.capturedAt,
    }),
  )}`
}

/** 差异区域快照指纹：区域几何、像素、忽略态共同构成依据 */
export const regionFingerprint = (regions: DifferenceRegion[]): string => {
  const compact = regions
    .map((region) => [
      region.id,
      region.x,
      region.y,
      region.width,
      region.height,
      region.pixels,
      region.severity,
      region.kind,
      region.ignored ? 1 : 0,
      region.ruleId ?? '',
    ].join(':'))
    .join('|')
  return `reg-${stableHash(compact)}`
}

const globLike = (pattern: string, value: string): boolean => {
  if (!pattern || pattern === '*') return true
  if (pattern === value) return true
  // 支持 * 通配的页面/设备模式
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}

/** 计算某条运行当前命中的启用忽略规则 */
export const matchedRulesForRun = (
  run: ScreenshotRun,
  rules: IgnoreRule[],
): IgnoreRule[] =>
  rules.filter(
    (rule) =>
      rule.enabled &&
      (rule.projectId === 'all' || rule.projectId === run.projectId) &&
      globLike(rule.pagePattern, run.page) &&
      globLike(rule.devicePattern, run.device),
  )

/** 单条规则修订号：规则内容（含启用态）决定，内容恢复原状则修订号也回到原值 */
export const ruleFingerprint = (rule: IgnoreRule): string =>
  `rule-${stableHash(
    JSON.stringify([
      rule.name,
      rule.projectId,
      rule.selector,
      rule.pagePattern,
      rule.devicePattern,
      rule.maxDelta,
      rule.enabled,
    ]),
  )}`

/** 单条规则的数字修订号，用于批次内命中规则快照 */
export const ruleRevisionOf = (rule: IgnoreRule): number =>
  parseInt(stableHash(ruleFingerprint(rule)), 36) % 1_000_000

/** 全局规则修订：任一规则变化都会产生新的修订号 */
export const rulesetRevision = (rules: IgnoreRule[]): number => {
  const joined = rules
    .map((rule) => `${rule.id}:${ruleFingerprint(rule)}`)
    .sort()
    .join('//')
  // 哈希到正整数，作为单调的“修订号”展示；内容回滚则修订号回退
  return parseInt(stableHash(joined), 36) % 1_000_000
}

const WINDOW_KEY = 'visual-regression-window-id'

/** 每个浏览器窗口稳定的身份标识（同源跨标签页唯一） */
export const getWindowId = (): string => {
  const existing = window.sessionStorage.getItem(WINDOW_KEY)
  if (existing) return existing
  const id = `win-${Math.random().toString(36).slice(2, 8)}`
  window.sessionStorage.setItem(WINDOW_KEY, id)
  return id
}

export const windowLabel = (id: string): string => {
  const suffix = id.replace(/^win-/, '').toUpperCase()
  return `窗口 ${suffix}`
}
