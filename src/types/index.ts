export type ReviewCategory = 'design-change' | 'render-error' | 'environment-noise'
export type RunStatus = 'pending' | 'approved' | 'rejected' | 'merged'
export type Severity = 'high' | 'medium' | 'low'
export type BatchStatus = 'open' | 'committed' | 'abandoned'
export type BatchPageStatus = 'pending' | 'approved' | 'rejected' | 'invalidated'
export type ReviewItemKind = 'rule-revision' | 'screenshot'
export type DraftSource = 'review' | 'region-ignore'

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
  /** 当前截图内容指纹，截图被另一窗口重拍/替换时会变化 */
  imageFingerprint?: string
  regions: DifferenceRegion[]
  review?: ReviewRecord
  mergedRunIds?: string[]
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
  /** 由批次统一切换产生的基线，记录批次来源 */
  batchId?: string
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
}

export interface DashboardData {
  pendingReview: number
  approvedToday: number
  highRisk: number
  activeBaselines: number
  trend: Array<{ date: string; total: number; failed: number }>
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

/** 单页审批结论（只作用于批次内对应页面） */
export interface PageDecision extends ReviewPayload {
  decidedAt: string
}

/** 依据变化后产生的复议项 */
export interface ReviewItem {
  id: string
  kind: ReviewItemKind
  detail: string
  /** 已完成页被失效时保留的原结论 */
  previousDecision?: PageDecision
  createdAt: string
  resolvedAt?: string
}

/** 批次内一个页面的批准依据快照与结论 */
export interface BatchPage {
  runId: string
  page: string
  device: string
  theme: 'light' | 'dark'
  /** 建批次时记录的当前图指纹 */
  imageFingerprint: string
  /** 建批次时命中的规则修订（全局规则修订号） */
  ruleRevision: number
  /** 命中的规则快照：规则 id + 修订号 */
  matchedRules: Array<{ id: string; revision: number }>
  /** 建批次时的差异区域快照（区域 id/像素/忽略态） */
  regionFingerprint: string
  status: BatchPageStatus
  decision?: PageDecision
  reviewItems: ReviewItem[]
}

/** 检查点：记录某页结论写入前的批次进度，用于失败恢复重放 */
export interface BatchCheckpoint {
  takenAt: string
  /** 截至检查点已完成（批准/驳回）的页面 runId 列表 */
  completedRunIds: string[]
  /** 已幂等处理过的结论操作 id */
  processedOpIds: string[]
  /** 结论写入中断时待重放的单页审批 */
  pendingDecision?: {
    opId: string
    runId: string
    payload: ReviewPayload
  }
  /** 基线切换中断时尚未写入的批准页 runId（按顺序重放） */
  pendingBaselineRunIds: string[]
  failedAt?: string
  failReason?: string
}

/** 另一窗口留下的审批草稿 */
export interface BatchDraft {
  id: string
  batchId: string
  windowId: string
  windowLabel: string
  runId: string
  source: DraftSource
  payload?: ReviewPayload
  ignoredRegionIds?: string[]
  /** 保存草稿时该页依据与当前规则修订是否已不一致 */
  changedPages: string[]
  savedAt: string
}

export interface ApprovalBatch {
  id: string
  name: string
  projectId: string
  release: string
  status: BatchStatus
  createdAt: string
  createdBy: string
  /** 建批次时的全局规则修订；提交时所有页必须重新对齐到当前修订 */
  ruleRevision: number
  pages: BatchPage[]
  checkpoint?: BatchCheckpoint
  drafts: BatchDraft[]
  committedAt?: string
  /** 提交切换基线后生成的基线 id */
  baselineIds?: string[]
}

/** 批次持有的跨窗口写入锁，同一时刻只允许一个窗口写入 */
export interface BatchLock {
  windowId: string
  windowLabel: string
  acquiredAt: string
  expiresAt: string
}

export interface CreateBatchPayload {
  name: string
  projectId: string
  release: string
  runIds: string[]
  createdBy: string
}

export interface BatchDraftPayload {
  windowId: string
  windowLabel: string
  runId: string
  source: DraftSource
  payload?: ReviewPayload
  ignoredRegionIds?: string[]
}

export interface PageDecisionPayload extends ReviewPayload {
  windowId: string
  opId: string
}

export interface CommitBatchPayload {
  windowId: string
  /** 演示用：强制让基线切换在写入中途失败，随后可从检查点恢复 */
  forceFail?: boolean
}

export interface RecoverBatchPayload {
  windowId: string
}

export interface BatchLockPayload {
  windowId: string
  windowLabel: string
}

export interface LockConflictData {
  code: 'LOCK_HELD'
  lock: BatchLock
}

export interface CommitResult {
  batch: ApprovalBatch
  baselines: Baseline[]
  replayed: number
}
