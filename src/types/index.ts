export type ReviewCategory = 'design-change' | 'render-error' | 'environment-noise'
export type RunStatus = 'pending' | 'approved' | 'rejected' | 'merged'
export type Severity = 'high' | 'medium' | 'low'

export interface Project {
  id: string
  name: string
  code: string
  owner: string
  pageCount: number
}

export interface DifferenceRegion {
  id: string
  x: number
  y: number
  width: number
  height: number
  severity: Severity
  pixels: number
  kind: 'layout' | 'content' | 'color' | 'environment'
  ignored: boolean
  ruleId?: string
}

export interface ReviewRecord {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  reviewedAt: string
}

export interface ScreenshotRun {
  id: string
  name: string
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  build: string
  status: RunStatus
  mismatchRate: number
  capturedAt: string
  baselineVersion: string
  currentVersion: string
  baselineImage?: string
  currentImage?: string
  /** 示意截图重采序号：换图后指纹随之改变。 */
  imageNonce?: number
  regions: DifferenceRegion[]
  review?: ReviewRecord
  mergedRunIds?: string[]
  /** 已通过批次生效产生的基线 id（单页直审也会回填）。 */
  baselineId?: string
  /** 依据所属批次 id。 */
  batchId?: string
}

export interface Baseline {
  id: string
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  version: string
  approvedBy: string
  reason: string
  approvedAt: string
  runId: string
  active: boolean
  /** 由批次生效产生的基线携带批次 id，单页直审为空。 */
  batchId?: string
  /** 生效时统一对齐到的规则修订。 */
  ruleRevision?: number
}

export interface IgnoreRule {
  id: string
  name: string
  projectId: string
  selector: string
  pagePattern: string
  devicePattern: string
  maxDelta: number
  enabled: boolean
  createdAt: string
  /** 规则自身修订号：任何内容或启停变更都会递增。 */
  revision?: number
}

export interface MatchedRuleSnapshot {
  ruleId: string
  name: string
  selector: string
  maxDelta: number
  enabled: boolean
  revision: number
}

export interface RegionSnapshot {
  id: string
  x: number
  y: number
  width: number
  height: number
  severity: Severity
  pixels: number
  kind: 'layout' | 'content' | 'color' | 'environment'
  ignored: boolean
  ruleId?: string
}

export type StaleKind = 'screenshot' | 'rules'

export interface StaleReason {
  kind: StaleKind
  detail: string
  changedAt: string
}

export interface AlignmentLogEntry {
  from: number
  to: number
  at: string
  detail: string
}

/** 建批次时为每页冻结的批准依据：图指纹 + 命中规则修订 + 差异区域。 */
export interface ApprovalBasis {
  imageFingerprint: string
  baselineFingerprint: string
  ruleRevision: number
  matchedRules: MatchedRuleSnapshot[]
  rulesHash: string
  regions: RegionSnapshot[]
  frozenAt: string
  /** 未命中页的规则修订对齐记录，证明依据仍落在最新修订。 */
  alignmentLog: AlignmentLogEntry[]
}

export type BatchItemStatus = 'pending' | 'approved' | 'rejected'
export type BatchItemValidity = 'fresh' | 'stale'

export interface ItemReviewEvidence {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  reviewedAt: string
  /** 结论所依据的规则修订与图指纹，从 basis 复制留痕。 */
  ruleRevision: number
  imageFingerprint: string
  rulesHash: string
}

export interface ReconsiderItem {
  /** 失效时保留下来的原依据。 */
  basis: ApprovalBasis
  /** 失效时保留下来的原结论。 */
  review?: ItemReviewEvidence
  reasons: StaleReason[]
  detectedAt: string
}

export interface BatchCheckpoint {
  runId: string
  decision: 'approved' | 'rejected'
  reviewedAt: string
  ruleRevision: number
  imageFingerprint: string
  rulesHash: string
  /** 批次生效阶段已落库的新基线 id，恢复重放时据此跳过。 */
  baselineId?: string
  /** 恢复时沿用的审批记录 id，避免重复新增。 */
  committed?: boolean
}

export interface BatchItem {
  runId: string
  status: BatchItemStatus
  validity: BatchItemValidity
  basis: ApprovalBasis
  review?: ItemReviewEvidence
  staleReasons?: StaleReason[]
  staleSince?: string
  /** 每次失效把上一轮依据/结论归档，形成复议项清单。 */
  reconsiderLog: ReconsiderItem[]
  checkpoint?: BatchCheckpoint
}

export type BatchStatus = 'open' | 'committing' | 'completed' | 'abandoned'

export interface BatchLock {
  windowId: string
  windowLabel: string
  acquiredAt: string
  /** 心跳时间；超过 TTL 视为窗口已关闭，允许接管。 */
  heartbeatAt: string
}

export interface BatchDraft {
  windowId: string
  windowLabel: string
  runId: string
  form: {
    category: ReviewCategory
    decision: 'approved' | 'rejected'
    reviewer: string
    reason: string
    ignoredRegionIds: string[]
  }
  savedAt: string
  /** 保存草稿时该页相比批次依据是否已经变化，提醒另一窗口。 */
  changedPages: Array<{ runId: string; kind: StaleKind; detail: string }>
}

export interface ApprovalBatch {
  id: string
  name: string
  createdBy: string
  createdAt: string
  status: BatchStatus
  ruleRevision: number
  items: BatchItem[]
  lock?: BatchLock
  drafts: BatchDraft[]
  completedAt?: string
  /** 批次生效时一次性产生的基线 id 列表。 */
  promotedBaselineIds?: string[]
  /** 批次生效时对齐到的统一规则修订。 */
  committedRuleRevision?: number
  failureNote?: string
}

export interface DashboardData {
  pendingReview: number
  approvedToday: number
  highRisk: number
  activeBaselines: number
  trend: Array<{ date: string; total: number; failed: number }>
  openBatches?: number
}

export interface RunFilters {
  projectId?: string
  page?: string
  device?: string
  theme?: string
  build?: string
  status?: string
  keyword?: string
}

export interface ReviewPayload {
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
}

export interface ImportRunPayload {
  projectId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  build: string
  baselineVersion: string
  currentVersion: string
  files: Array<{ name: string; size: number; dataUrl: string }>
  baselineImage?: string
}

export interface CreateBatchPayload {
  name: string
  runIds: string[]
  createdBy: string
  windowId: string
  windowLabel: string
  acquireLock?: boolean
}

export interface BatchItemReviewPayload {
  windowId: string
  category: ReviewCategory
  decision: 'approved' | 'rejected'
  reviewer: string
  reason: string
  ignoredRegionIds: string[]
}

export interface SaveDraftPayload {
  windowId: string
  windowLabel: string
  runId: string
  form: Omit<BatchItemReviewPayload, 'windowId'>
}

export interface LockPayload {
  windowId: string
  windowLabel: string
}

export interface LockInfo {
  held: boolean
  lock?: BatchLock
  /** 心跳续约 TTL（毫秒）。 */
  ttlMs: number
}

export interface BatchDetail {
  batch: ApprovalBatch
  lock: LockInfo
  runs: ScreenshotRun[]
  ruleRevision: number
  /** 批次冻结时的修订与当前修订是否一致。 */
  revisionCurrent: boolean
}
