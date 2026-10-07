import type {
  DifferenceRegion,
  IgnoreRule,
  MatchedRuleSnapshot,
  RegionSnapshot,
  ScreenshotRun,
  StaleReason,
} from '@/types'

/**
 * 批准依据（approval basis）相关的纯函数：
 * 图指纹、规则命中、规则集哈希、依据冻结与失效比对。
 * 浏览器 mock 适配器与界面都复用这一套，保证判定口径唯一。
 */

/** 32 位 FNV-1a，输出短十六进制指纹，localStorage 体积友好。 */
export const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fp-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** 仅支持 '*' 的轻量通配匹配：`*` 匹配任意，其余按分段包含判断。 */
export const globMatch = (pattern: string, value: string): boolean => {
  const trimmed = pattern.trim()
  if (!trimmed || trimmed === '*') return true
  const segments = trimmed.split('*').filter(Boolean)
  let cursor = 0
  return segments.every((segment) => {
    const index = value.indexOf(segment, cursor)
    if (index < 0) return false
    cursor = index + segment.length
    return true
  })
}

/** 规则是否作用于某次运行（项目 + 页面 + 设备三重作用域）。 */
export const ruleMatchesRun = (rule: IgnoreRule, run: ScreenshotRun): boolean => {
  if (rule.projectId !== 'all' && rule.projectId !== run.projectId) return false
  if (!globMatch(rule.pagePattern, run.page)) return false
  if (!globMatch(rule.devicePattern, run.device)) return false
  return true
}

export const matchingRules = (run: ScreenshotRun, rules: IgnoreRule[]): IgnoreRule[] =>
  rules
    .filter((rule) => ruleMatchesRun(rule, run))
    .sort((a, b) => a.id.localeCompare(b.id))

const snapshotRule = (rule: IgnoreRule): MatchedRuleSnapshot => ({
  ruleId: rule.id,
  name: rule.name,
  selector: rule.selector,
  maxDelta: rule.maxDelta,
  enabled: rule.enabled,
  revision: rule.revision ?? 1,
})

/** 当前图指纹：优先对真实 dataURL 取指纹；示意 SVG 用运行内容 + 采集序号。 */
export const runImageFingerprint = (run: ScreenshotRun): string => {
  if (run.currentImage) return fnv1a(run.currentImage)
  const regionDigest = run.regions
    .map((region) => [region.id, region.x, region.y, region.width, region.height, region.pixels].join(':'))
    .join(';')
  return fnv1a(
    [run.id, run.currentVersion, run.capturedAt, run.imageNonce ?? 0, regionDigest].join('|'),
  )
}

export const baselineImageFingerprint = (run: ScreenshotRun): string => {
  if (run.baselineImage) return fnv1a(run.baselineImage)
  return fnv1a([run.id, run.baselineVersion].join('|'))
}

/**
 * 命中规则集内容指纹：启用状态/选择器/色差任一变化都会变化。
 * 刻意不含 revision——内容不变、仅修订号前移时按"自动对齐"处理。
 */
export const rulesFingerprint = (run: ScreenshotRun, rules: IgnoreRule[]): string => {
  const digest = matchingRules(run, rules).map((rule) => ({
    ruleId: rule.id,
    selector: rule.selector,
    maxDelta: rule.maxDelta,
    enabled: rule.enabled,
  }))
  return fnv1a(JSON.stringify(digest))
}

export const snapshotRegions = (regions: DifferenceRegion[]): RegionSnapshot[] =>
  regions.map((region) => ({
    id: region.id,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    severity: region.severity,
    pixels: region.pixels,
    kind: region.kind,
    ignored: region.ignored,
    ruleId: region.ruleId,
  }))

interface BuildBasisArgs {
  run: ScreenshotRun
  rules: IgnoreRule[]
  ruleRevision: number
  frozenAt: string
}

/** 建批次 / 复议时冻结一份完整批准依据。 */
export const buildBasis = ({ run, rules, ruleRevision, frozenAt }: BuildBasisArgs) => ({
  imageFingerprint: runImageFingerprint(run),
  baselineFingerprint: baselineImageFingerprint(run),
  ruleRevision,
  matchedRules: matchingRules(run, rules).map(snapshotRule),
  rulesHash: rulesFingerprint(run, rules),
  regions: snapshotRegions(run.regions),
  frozenAt,
  alignmentLog: [] as Array<{ from: number; to: number; at: string; detail: string }>,
})

interface BasisDiffArgs {
  basis: ReturnType<typeof buildBasis>
  run: ScreenshotRun
  rules: IgnoreRule[]
  changedAt: string
}

/** 依据失效原因：截图被换、命中规则内容变化。 */
export const diffBasis = ({ basis, run, rules, changedAt }: BasisDiffArgs): StaleReason[] => {
  const reasons: StaleReason[] = []
  if (runImageFingerprint(run) !== basis.imageFingerprint) {
    reasons.push({
      kind: 'screenshot',
      detail: `当前图指纹已由 ${basis.imageFingerprint} 变为 ${runImageFingerprint(run)}（采集于 ${run.capturedAt.slice(5, 16).replace('T', ' ')}）`,
      changedAt,
    })
  }
  if (rulesFingerprint(run, rules) !== basis.rulesHash) {
    reasons.push({
      kind: 'rules',
      detail: `命中的忽略规则在修订 r${basis.ruleRevision} 之后发生增删改或启停，当前命中 ${matchingRules(
        run,
        rules,
      ).length} 条`,
      changedAt,
    })
  }
  return reasons
}

export const shortFingerprint = (fingerprint: string): string => fingerprint.slice(3, 11)
