import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { readDb, writeDb } from '@/mocks/db'
import { buildBasis, diffBasis, fnv1a } from '@/utils/basis'
import type {
  ApprovalBatch,
  Baseline,
  BatchCheckpoint,
  BatchDetail,
  BatchDraft,
  BatchItem,
  BatchItemReviewPayload,
  CreateBatchPayload,
  DashboardData,
  IgnoreRule,
  ImportRunPayload,
  LockInfo,
  LockPayload,
  Project,
  ReviewPayload,
  RunFilters,
  SaveDraftPayload,
  ScreenshotRun,
} from '@/types'

export const api = axios.create({
  baseURL: '/mock-api',
  timeout: 8000,
  headers: { 'Content-Type': 'application/json' },
})

const LOCK_TTL_MS = 15_000
/** 演示用：置 true 后下一次批次生效的落库步骤会失败，随后自动恢复。 */
let failNextWrite = false

const respond = <T>(config: InternalAxiosRequestConfig, data: T, status = 200) => ({
  data,
  status,
  statusText: status === 200 ? 'OK' : 'Created',
  headers: {},
  config,
})

const parseBody = <T>(config: InternalAxiosRequestConfig): T => {
  if (typeof config.data === 'string') return JSON.parse(config.data) as T
  return config.data as T
}

const nowIso = () => new Date().toISOString()

const isLockAlive = (batch: ApprovalBatch): boolean => {
  if (!batch.lock) return false
  return Date.now() - new Date(batch.lock.heartbeatAt).getTime() < LOCK_TTL_MS
}

/** 续约存活的锁；锁过期则清除，返回清理后的状态。 */
const refreshLock = (batch: ApprovalBatch): boolean => {
  if (batch.lock && !isLockAlive(batch)) batch.lock = undefined
  return Boolean(batch.lock)
}

const assertLockedBy = (batch: ApprovalBatch, windowId: string): LockInfo['lock'] => {
  if (!batch.lock) throw new Error('当前批次没有写入锁，请先接管批次再写入')
  if (!isLockAlive(batch)) throw new Error('写入锁已过期，请重新接管批次')
  if (batch.lock.windowId !== windowId) {
    throw new Error(`批次正由窗口「${batch.lock.windowLabel}」编辑，请先保存草稿`)
  }
  return batch.lock
}

const lockInfo = (batch: ApprovalBatch, windowId: string): LockInfo => {
  refreshLock(batch)
  return {
    held: Boolean(batch.lock && batch.lock.windowId === windowId),
    lock: batch.lock,
    ttlMs: LOCK_TTL_MS,
  }
}

const detailRuns = (batch: ApprovalBatch, runs: ScreenshotRun[]): ScreenshotRun[] =>
  batch.items
    .map((item) => runs.find((run) => run.id === item.runId))
    .filter((run): run is ScreenshotRun => Boolean(run))

/**
 * 依据刷新（每次写批次前调用）：
 * - 截图指纹或命中规则内容变化 → 对应页失效，原依据/原结论归档进复议项
 * - 仅全局修订前移、内容不变 → 未受影响页自动对齐到新修订，依据保持有效
 */
const refreshItems = (
  batch: ApprovalBatch,
  runs: ScreenshotRun[],
  rules: IgnoreRule[],
): ApprovalBatch => {
  const at = nowIso()
  for (const item of batch.items) {
    const run = runs.find((candidate) => candidate.id === item.runId)
    if (!run) continue

    const reasons = diffBasis({ basis: item.basis, run, rules, changedAt: at })
    if (reasons.length > 0) {
      if (item.validity === 'fresh') {
        item.reconsiderLog.push({
          basis: JSON.parse(JSON.stringify(item.basis)),
          review: item.review ? JSON.parse(JSON.stringify(item.review)) : undefined,
          reasons,
          detectedAt: at,
        })
        item.validity = 'stale'
        item.staleReasons = reasons
        item.staleSince = at
        item.status = 'pending'
        item.review = undefined
        if (run.status !== 'merged') run.status = 'pending'
        run.batchId = batch.id
      }
      continue
    }

    if (item.validity === 'fresh' && item.basis.ruleRevision !== batch.ruleRevision) {
      const from = item.basis.ruleRevision
      item.basis.alignmentLog.push({
        from,
        to: batch.ruleRevision,
        at,
        detail: '与本页命中规则无关的规则修订，依据内容未变，自动对齐',
      })
      item.basis.ruleRevision = batch.ruleRevision
    }
  }
  return batch
}

const changedPageHints = (
  batch: ApprovalBatch,
  runs: ScreenshotRun[],
  rules: IgnoreRule[],
): BatchDraft['changedPages'] =>
  batch.items.flatMap((item) => {
    const run = runs.find((candidate) => candidate.id === item.runId)
    if (!run) return []
    return diffBasis({ basis: item.basis, run, rules, changedAt: nowIso() }).map((reason) => ({
      runId: item.runId,
      kind: reason.kind,
      detail: reason.detail,
    }))
  })

const mockAdapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => window.setTimeout(resolve, 180))
  const db = readDb()
  const method = (config.method ?? 'get').toLowerCase()
  const path = config.url ?? ''

  if (method === 'get' && path === '/projects') {
    return respond<Project[]>(config, db.projects)
  }

  if (method === 'get' && path === '/dashboard') {
    const openBatches = db.batches.filter((batch) => batch.status === 'open').length
    const dashboard: DashboardData = {
      pendingReview: db.runs.filter((run) => run.status === 'pending').length,
      approvedToday: db.runs.filter(
        (run) => run.review?.decision === 'approved' && run.review.reviewedAt.startsWith('2026-09-29'),
      ).length,
      highRisk: db.runs.filter((run) => run.mismatchRate >= 5 && run.status !== 'merged').length,
      activeBaselines: db.baselines.filter((baseline) => baseline.active).length,
      trend: [
        { date: '09-23', total: 36, failed: 7 },
        { date: '09-24', total: 42, failed: 4 },
        { date: '09-25', total: 39, failed: 9 },
        { date: '09-26', total: 47, failed: 6 },
        { date: '09-27', total: 44, failed: 5 },
        { date: '09-28', total: 52, failed: 11 },
        { date: '09-29', total: 29, failed: 8 },
      ],
      openBatches,
    }
    return respond(config, dashboard)
  }

  if (method === 'get' && path === '/runs') {
    const filters = (config.params ?? {}) as RunFilters
    const keyword = filters.keyword?.trim().toLowerCase()
    const data = db.runs.filter((run) => {
      return (
        (!filters.projectId || run.projectId === filters.projectId) &&
        (!filters.page || run.page === filters.page) &&
        (!filters.device || run.device === filters.device) &&
        (!filters.theme || run.theme === filters.theme) &&
        (!filters.build || run.build === filters.build) &&
        (!filters.status || run.status === filters.status) &&
        (!keyword ||
          run.name.toLowerCase().includes(keyword) ||
          run.page.toLowerCase().includes(keyword) ||
          run.id.toLowerCase().includes(keyword))
      )
    })
    return respond(config, data)
  }

  const runMatch = path.match(/^\/runs\/([^/]+)$/)
  if (method === 'get' && runMatch) {
    const run = db.runs.find((item) => item.id === runMatch[1])
    if (!run) throw new Error('运行记录不存在')
    return respond(config, run)
  }

  /** 单页直审（兼容旧入口）：审批立即落库并切换该页基线，不归属任何批次。 */
  const reviewMatch = path.match(/^\/runs\/([^/]+)\/review$/)
  if (method === 'patch' && reviewMatch) {
    const payload = parseBody<ReviewPayload>(config)
    const run = db.runs.find((item) => item.id === reviewMatch[1])
    if (!run) throw new Error('运行记录不存在')
    const inOpenBatch = db.batches.some(
      (batch) => batch.status === 'open' && batch.items.some((item) => item.runId === run.id),
    )
    if (inOpenBatch) {
      throw new Error('该页面属于开放中的批准批次，请在批次内逐页审批以保持批准依据一致')
    }
    run.status = payload.decision
    run.review = { ...payload, reviewedAt: nowIso() }
    if (payload.decision === 'approved') {
      promoteBaselines(db, [{ run, reviewer: payload.reviewer, reason: payload.reason }])
    }
    writeDb(db)
    return respond(config, run)
  }

  if (method === 'post' && path === '/runs/merge') {
    const ids = parseBody<string[]>(config)
    const selected = db.runs.filter((run) => ids.includes(run.id))
    if (selected.length < 2) throw new Error('至少选择两条运行记录进行合并')
    const [first, ...rest] = selected
    first.mergedRunIds = selected.map((run) => run.id)
    first.status = 'merged'
    first.mismatchRate =
      selected.reduce((sum, run) => sum + run.mismatchRate, 0) / Math.max(selected.length, 1)
    first.regions = rest.flatMap((run) => run.regions).slice(0, 8)
    writeDb(db)
    return respond(config, first, 201)
  }

  if (method === 'post' && path === '/runs/import') {
    const payload = parseBody<ImportRunPayload>(config)
    if (
      !payload.projectId ||
      !payload.page.trim() ||
      !payload.device.trim() ||
      !payload.build.trim() ||
      payload.files.length === 0
    ) {
      throw new Error('项目、页面、设备、构建版本和截图文件不能为空')
    }
    const stamp = Date.now()
    const imported = payload.files.map((file, index) => {
      const runId = `run-${stamp}-${index + 1}`
      const mismatchRate = Number((0.8 + ((file.name.length + index * 3) % 58) / 10).toFixed(2))
      const severity = mismatchRate >= 5 ? 'high' : mismatchRate >= 2 ? 'medium' : 'low'
      const run: ScreenshotRun = {
        id: runId,
        name: `${payload.page} ${payload.device}回归`,
        projectId: payload.projectId,
        page: payload.page.trim(),
        device: payload.device.trim(),
        theme: payload.theme,
        build: payload.build.trim(),
        status: 'pending',
        mismatchRate,
        capturedAt: nowIso(),
        baselineVersion: payload.baselineVersion.trim() || '当前有效基线',
        currentVersion: payload.currentVersion.trim() || payload.build.trim(),
        baselineImage: payload.baselineImage,
        currentImage: file.dataUrl,
        imageNonce: 0,
        regions: [
          {
            id: `${runId}-r1`,
            x: 12 + index * 3,
            y: 22 + index * 2,
            width: 24,
            height: 14,
            severity,
            pixels: Math.round(file.size / 8 || 620),
            kind: 'layout',
            ignored: false,
          },
          {
            id: `${runId}-r2`,
            x: 58,
            y: 52,
            width: 16,
            height: 10,
            severity: severity === 'high' ? 'medium' : 'low',
            pixels: Math.round(file.size / 18 || 180),
            kind: 'color',
            ignored: false,
          },
        ],
      }
      return run
    })
    db.runs.unshift(...imported)
    writeDb(db)
    return respond(config, imported, 201)
  }

  if (method === 'get' && path === '/baselines') {
    const projectId = config.params?.projectId as string | undefined
    return respond(
      config,
      db.baselines.filter((baseline) => !projectId || baseline.projectId === projectId),
    )
  }

  if (method === 'get' && path === '/rules') {
    return respond<IgnoreRule[]>(config, db.rules)
  }

  if (method === 'post' && path === '/rules') {
    const input = parseBody<Omit<IgnoreRule, 'id' | 'createdAt' | 'revision'>>(config)
    db.ruleRevision += 1
    const rule: IgnoreRule = {
      ...input,
      id: `rule-${Date.now()}`,
      createdAt: nowIso(),
      revision: db.ruleRevision,
    }
    db.rules.unshift(rule)
    cascadeRuleChange(db)
    writeDb(db)
    return respond(config, rule, 201)
  }

  const ruleMatch = path.match(/^\/rules\/([^/]+)$/)
  if (method === 'patch' && ruleMatch) {
    const payload = parseBody<Partial<IgnoreRule>>(config)
    const rule = db.rules.find((item) => item.id === ruleMatch[1])
    if (!rule) throw new Error('规则不存在')
    const before = { ...rule }
    Object.assign(rule, payload)
    const contentChanged =
      before.selector !== rule.selector ||
      before.maxDelta !== rule.maxDelta ||
      before.enabled !== rule.enabled ||
      before.projectId !== rule.projectId ||
      before.pagePattern !== rule.pagePattern ||
      before.devicePattern !== rule.devicePattern
    if (contentChanged) {
      db.ruleRevision += 1
      rule.revision = db.ruleRevision
      cascadeRuleChange(db)
    }
    writeDb(db)
    return respond(config, rule)
  }
  if (method === 'delete' && ruleMatch) {
    const index = db.rules.findIndex((item) => item.id === ruleMatch[1])
    if (index < 0) throw new Error('规则不存在')
    db.rules.splice(index, 1)
    db.ruleRevision += 1
    cascadeRuleChange(db)
    writeDb(db)
    return respond(config, { success: true })
  }

  /* ------------------------- 批次：创建 / 查询 ------------------------- */

  if (method === 'get' && path === '/batches') {
    db.batches.forEach((batch) => refreshLock(batch))
    writeDb(db)
    return respond(config, db.batches)
  }

  if (method === 'post' && path === '/batches') {
    const payload = parseBody<CreateBatchPayload>(config)
    if (!payload.name.trim()) throw new Error('批次名称不能为空')
    const uniqueIds = [...new Set(payload.runIds)]
    if (uniqueIds.length < 2) throw new Error('批次至少包含 2 个页面')
    const targetRuns = uniqueIds
      .map((id) => db.runs.find((run) => run.id === id))
      .filter((run): run is ScreenshotRun => Boolean(run))
    if (targetRuns.length !== uniqueIds.length) throw new Error('部分运行记录不存在')
    if (targetRuns.some((run) => run.status === 'merged')) {
      throw new Error('已合并运行不能进入批次，请选择原始运行')
    }

    const frozenAt = nowIso()
    const items: BatchItem[] = targetRuns.map((run) => ({
      runId: run.id,
      status: 'pending',
      validity: 'fresh',
      basis: buildBasis({ run, rules: db.rules, ruleRevision: db.ruleRevision, frozenAt }),
      reconsiderLog: [],
    }))

    const batch: ApprovalBatch = {
      id: `batch-${Date.now()}`,
      name: payload.name.trim(),
      createdBy: payload.createdBy,
      createdAt: frozenAt,
      status: 'open',
      ruleRevision: db.ruleRevision,
      items,
      drafts: [],
    }
    targetRuns.forEach((run) => {
      run.batchId = batch.id
    })
    if (payload.acquireLock !== false) {
      batch.lock = {
        windowId: payload.windowId,
        windowLabel: payload.windowLabel,
        acquiredAt: frozenAt,
        heartbeatAt: frozenAt,
      }
    }
    db.batches.unshift(batch)
    writeDb(db)
    return respond(config, toDetail(db, batch, payload.windowId), 201)
  }

  const batchMatch = path.match(/^\/batches\/([^/]+)$/)
  if (method === 'get' && batchMatch) {
    const windowId = String(config.params?.windowId ?? '')
    const batch = db.batches.find((item) => item.id === batchMatch[1])
    if (!batch) throw new Error('批次不存在')
    refreshItems(batch, db.runs, db.rules)
    refreshLock(batch)
    writeDb(db)
    return respond(config, toDetail(db, batch, windowId))
  }

  if (method === 'delete' && batchMatch) {
    const index = db.batches.findIndex((item) => item.id === batchMatch[1])
    if (index < 0) throw new Error('批次不存在')
    const [removed] = db.batches.splice(index, 1)
    for (const run of db.runs) if (run.batchId === removed.id) run.batchId = undefined
    writeDb(db)
    return respond(config, { success: true })
  }

  /* ------------------------- 批次：写锁 / 草稿 ------------------------- */

  const lockMatch = path.match(/^\/batches\/([^/]+)\/lock$/)
  if (method === 'post' && lockMatch) {
    const payload = parseBody<LockPayload>(config)
    const batch = db.batches.find((item) => item.id === lockMatch[1])
    if (!batch) throw new Error('批次不存在')
    if (batch.status !== 'open') throw new Error('批次已结束，不能再获取写锁')
    refreshItems(batch, db.runs, db.rules)
    refreshLock(batch)
    if (batch.lock && batch.lock.windowId !== payload.windowId) {
      throw new Error(`窗口「${batch.lock.windowLabel}」正在写入，请等待其完成或保存草稿`)
    }
    const stamp = nowIso()
    batch.lock = batch.lock ?? {
      windowId: payload.windowId,
      windowLabel: payload.windowLabel,
      acquiredAt: stamp,
      heartbeatAt: stamp,
    }
    batch.lock.windowLabel = payload.windowLabel
    batch.lock.heartbeatAt = stamp
    writeDb(db)
    return respond(config, toDetail(db, batch, payload.windowId))
  }

  const heartbeatMatch = path.match(/^\/batches\/([^/]+)\/heartbeat$/)
  if (method === 'post' && heartbeatMatch) {
    const payload = parseBody<LockPayload>(config)
    const batch = db.batches.find((item) => item.id === heartbeatMatch[1])
    if (!batch) throw new Error('批次不存在')
    refreshLock(batch)
    if (batch.lock?.windowId === payload.windowId) {
      batch.lock.heartbeatAt = nowIso()
      writeDb(db)
    }
    return respond(config, lockInfo(batch, payload.windowId))
  }

  const unlockMatch = path.match(/^\/batches\/([^/]+)\/unlock$/)
  if (method === 'post' && unlockMatch) {
    const payload = parseBody<LockPayload>(config)
    const batch = db.batches.find((item) => item.id === unlockMatch[1])
    if (!batch) throw new Error('批次不存在')
    if (batch.lock?.windowId === payload.windowId) batch.lock = undefined
    writeDb(db)
    return respond(config, { success: true })
  }

  const draftMatch = path.match(/^\/batches\/([^/]+)\/drafts$/)
  if (method === 'post' && draftMatch) {
    const payload = parseBody<SaveDraftPayload>(config)
    const batch = db.batches.find((item) => item.id === draftMatch[1])
    if (!batch) throw new Error('批次不存在')
    refreshItems(batch, db.runs, db.rules)
    const savedAt = nowIso()
    const draft: BatchDraft = {
      windowId: payload.windowId,
      windowLabel: payload.windowLabel,
      runId: payload.runId,
      form: {
        category: payload.form.category,
        decision: payload.form.decision,
        reviewer: payload.form.reviewer,
        reason: payload.form.reason,
        ignoredRegionIds: payload.form.ignoredRegionIds,
      },
      savedAt,
      changedPages: changedPageHints(batch, db.runs, db.rules),
    }
    const existing = batch.drafts.findIndex(
      (item) => item.windowId === draft.windowId && item.runId === draft.runId,
    )
    if (existing >= 0) batch.drafts.splice(existing, 1, draft)
    else batch.drafts.push(draft)
    writeDb(db)
    return respond(config, draft, 201)
  }

  /* ------------------------- 批次：单页结论 ------------------------- */

  const itemReviewMatch = path.match(/^\/batches\/([^/]+)\/items\/([^/]+)\/review$/)
  if (method === 'post' && itemReviewMatch) {
    const payload = parseBody<BatchItemReviewPayload>(config)
    const batch = db.batches.find((item) => item.id === itemReviewMatch[1])
    if (!batch) throw new Error('批次不存在')
    if (batch.status !== 'open') throw new Error('批次已结束')
    refreshItems(batch, db.runs, db.rules)
    assertLockedBy(batch, payload.windowId)

    const item = batch.items.find((candidate) => candidate.runId === itemReviewMatch[2])
    const run = db.runs.find((candidate) => candidate.id === itemReviewMatch[2])
    if (!item || !run) throw new Error('批次内不存在该页面')
    if (item.validity === 'stale') {
      throw new Error('该页依据已失效，请先按最新截图与规则重新冻结后再审批')
    }

    const reviewedAt = nowIso()
    item.status = payload.decision
    item.review = {
      category: payload.category,
      decision: payload.decision,
      reviewer: payload.reviewer,
      reason: payload.reason,
      reviewedAt,
      ruleRevision: item.basis.ruleRevision,
      imageFingerprint: item.basis.imageFingerprint,
      rulesHash: item.basis.rulesHash,
    }
    run.status = payload.decision === 'approved' ? 'pending' : 'rejected'
    run.review = {
      category: payload.category,
      decision: payload.decision,
      reviewer: payload.reviewer,
      reason: payload.reason,
      reviewedAt,
    }
    run.batchId = batch.id
    for (const region of run.regions) region.ignored = payload.ignoredRegionIds.includes(region.id)

    // 单页检查点：批次生效写失败后从这里恢复，重放不重复新增。
    const checkpoint: BatchCheckpoint = {
      runId: run.id,
      decision: payload.decision,
      reviewedAt,
      ruleRevision: item.basis.ruleRevision,
      imageFingerprint: item.basis.imageFingerprint,
      rulesHash: item.basis.rulesHash,
      committed: Boolean(item.checkpoint?.committed),
      baselineId: item.checkpoint?.baselineId,
    }
    item.checkpoint = checkpoint

    batch.drafts = batch.drafts.filter(
      (draft) => !(draft.windowId === payload.windowId && draft.runId === run.id),
    )
    writeDb(db)
    return respond(config, toDetail(db, batch, payload.windowId))
  }

  /** 失效页复议：按最新截图/规则重新冻结依据，原依据与结论已留在复议项中。 */
  const refreezeMatch = path.match(/^\/batches\/([^/]+)\/items\/([^/]+)\/refreeze$/)
  if (method === 'post' && refreezeMatch) {
    const payload = parseBody<LockPayload>(config)
    const batch = db.batches.find((item) => item.id === refreezeMatch[1])
    if (!batch) throw new Error('批次不存在')
    assertLockedBy(batch, payload.windowId)
    const item = batch.items.find((candidate) => candidate.runId === refreezeMatch[2])
    const run = db.runs.find((candidate) => candidate.id === refreezeMatch[2])
    if (!item || !run) throw new Error('批次内不存在该页面')
    if (item.validity !== 'stale') throw new Error('该页依据仍有效，无需复议')
    // 复议即"以当前截图与规则为新依据"，原依据/结论已归档进 reconsiderLog，等待重新审批。
    item.basis = buildBasis({ run, rules: db.rules, ruleRevision: batch.ruleRevision, frozenAt: nowIso() })
    item.validity = 'fresh'
    item.staleReasons = undefined
    item.staleSince = undefined
    writeDb(db)
    return respond(config, toDetail(db, batch, payload.windowId))
  }

  /** 演示用：替换某页当前图（指纹变化），用于验证跨窗口失效联动。 */
  const recaptureMatch = path.match(/^\/batches\/([^/]+)\/items\/([^/]+)\/recapture$/)
  if (method === 'post' && recaptureMatch) {
    const payload = parseBody<LockPayload>(config)
    const batch = db.batches.find((item) => item.id === recaptureMatch[1])
    if (!batch) throw new Error('批次不存在')
    assertLockedBy(batch, payload.windowId)
    const run = db.runs.find((candidate) => candidate.id === recaptureMatch[2])
    if (!run) throw new Error('批次内不存在该页面')
    run.imageNonce = (run.imageNonce ?? 0) + 1
    run.capturedAt = nowIso()
    writeDb(db)
    refreshItems(batch, db.runs, db.rules)
    writeDb(db)
    return respond(config, toDetail(db, batch, payload.windowId))
  }

  /* ------------------------- 批次：完成 / 生效 / 恢复 ------------------------- */

  const completeMatch = path.match(/^\/batches\/([^/]+)\/complete$/)
  if (method === 'post' && completeMatch) {
    const payload = parseBody<LockPayload>(config)
    const batch = db.batches.find((item) => item.id === completeMatch[1])
    if (!batch) throw new Error('批次不存在')
    if (batch.status === 'completed') return respond(config, toDetail(db, batch, payload.windowId))
    refreshItems(batch, db.runs, db.rules)
    assertLockedBy(batch, payload.windowId)

    const stalePages = batch.items.filter((item) => item.validity === 'stale')
    if (stalePages.length > 0) {
      throw new Error(`还有 ${stalePages.length} 个页面依据失效待复议，无法生效`)
    }
    const pendingPages = batch.items.filter((item) => item.status !== 'approved' && item.status !== 'rejected')
    if (pendingPages.length > 0) {
      throw new Error(`还有 ${pendingPages.length} 个页面未给出结论`)
    }
    const revisions = new Set(batch.items.map((item) => item.basis.ruleRevision))
    if (revisions.size !== 1 || [...revisions][0] !== batch.ruleRevision) {
      throw new Error(`各页依据未对齐到同一规则修订（当前 r${batch.ruleRevision}），请先复议`)
    }

    // 恢复判据以"基线是否真实落库"为准，而非仅看内存检查点标记。
    const approvedItems = batch.items.filter((item) => item.status === 'approved')
    const pendingPromotions = approvedItems.filter((item) => {
      const run = db.runs.find((candidate) => candidate.id === item.runId)!
      const persisted = Boolean(
        item.checkpoint?.baselineId &&
          db.baselines.some(
            (base) => base.id === item.checkpoint?.baselineId && base.batchId === batch.id,
          ),
      )
      if (persisted) {
        // 上一轮已落库的页面：恢复时标记 committed，重放直接跳过，不重复新增。
        item.checkpoint = { ...(item.checkpoint as BatchCheckpoint), committed: true }
        run.status = 'approved'
        run.baselineId = item.checkpoint?.baselineId
      }
      return !persisted
    })

    try {
      batch.status = 'committing'
      writeDb(db)

      // 逐页检查点落盘：任一页写入失败，前序页面的审批与基线都已持久化。
      for (const item of pendingPromotions) {
        const run = db.runs.find((candidate) => candidate.id === item.runId)!
        const [baseline] = promoteBaselines(db, [
          {
            run,
            reviewer: item.review?.reviewer ?? batch.createdBy,
            reason: item.review?.reason ?? `批次 ${batch.name} 批准生效`,
            batch,
          },
        ])
        run.status = 'approved'
        run.baselineId = baseline.id
        item.checkpoint = {
          ...(item.checkpoint as BatchCheckpoint),
          committed: true,
          baselineId: baseline.id,
        }
        writeDb(db)
        if (failNextWrite) {
          failNextWrite = false
          throw new Error('写入失败（模拟）：部分页面基线已落盘，将从检查点恢复')
        }
      }

      batch.promotedBaselineIds = approvedItems
        .map((item) => item.checkpoint?.baselineId)
        .filter((id): id is string => Boolean(id))
      batch.committedRuleRevision = batch.ruleRevision
      batch.status = 'completed'
      batch.completedAt = nowIso()
      batch.failureNote = undefined
      batch.lock = undefined
      writeDb(db)
      return respond(config, toDetail(db, batch, payload.windowId))
    } catch (error) {
      // 生效中断：批次回到 open，已落盘页面的检查点与基线保留，等待恢复重放。
      batch.status = 'open'
      batch.failureNote = error instanceof Error ? error.message : '批次生效写入失败'
      writeDb(db)
      throw error
    }
  }

  const failWriteMatch = path.match(/^\/batches\/([^/]+)\/fail-next-write$/)
  if (method === 'post' && failWriteMatch) {
    failNextWrite = true
    return respond(config, { armed: true })
  }

  throw new Error(`Mock API 未实现：${method.toUpperCase()} ${path}`)
}

/* ----------------------------- 辅助：基线切换 ----------------------------- */

interface PromotionTarget {
  run: ScreenshotRun
  reviewer: string
  reason: string
  batch?: ApprovalBatch
}

/**
 * 原子切换：停用同坐标（项目/页面/设备/主题）旧基线，新增一批同修订新基线。
 * 新基线用确定性 id，批次恢复重放时同一 run 不会重复新增。
 */
const promoteBaselines = (
  db: ReturnType<typeof readDb>,
  targets: PromotionTarget[],
): Baseline[] => {
  const created: Baseline[] = []
  for (const target of targets) {
    const { run } = target
    const deterministicId = target.batch
      ? `base-${target.batch.id}-${run.id}`
      : `base-direct-${run.id}-${fnv1a(run.review?.reviewedAt ?? String(Date.now())).slice(3, 9)}`
    const existing = db.baselines.find((base) => base.id === deterministicId)
    if (existing) {
      created.push(existing)
      continue
    }
    for (const base of db.baselines) {
      if (
        base.projectId === run.projectId &&
        base.page === run.page &&
        base.device === run.device &&
        base.theme === run.theme &&
        base.active
      ) {
        base.active = false
      }
    }
    const baseline: Baseline = {
      id: deterministicId,
      projectId: run.projectId,
      page: run.page,
      device: run.device,
      theme: run.theme,
      version: run.currentVersion,
      approvedBy: target.reviewer,
      reason: target.reason,
      approvedAt: nowIso(),
      runId: run.id,
      active: true,
      batchId: target.batch?.id,
      ruleRevision: target.batch?.ruleRevision,
    }
    db.baselines.unshift(baseline)
    created.push(baseline)
  }
  return created
}

/**
 * 规则变化后的全局联动：修订号前移，并让所有打开批次重新核对依据。
 * 内容无关的页面只做修订对齐，命中变化的页面立即失效待审。
 */
const cascadeRuleChange = (db: ReturnType<typeof readDb>): void => {
  for (const batch of db.batches) {
    if (batch.status !== 'open') continue
    batch.ruleRevision = db.ruleRevision
    refreshItems(batch, db.runs, db.rules)
  }
}

const toDetail = (
  db: ReturnType<typeof readDb>,
  batch: ApprovalBatch,
  windowId: string,
): BatchDetail => ({
  batch,
  lock: lockInfo(batch, windowId),
  runs: detailRuns(batch, db.runs),
  ruleRevision: db.ruleRevision,
  revisionCurrent: batch.ruleRevision === db.ruleRevision,
})

api.defaults.adapter = mockAdapter

export const getProjects = async (): Promise<Project[]> => (await api.get<Project[]>('/projects')).data
export const getDashboard = async (): Promise<DashboardData> =>
  (await api.get<DashboardData>('/dashboard')).data
export const getRuns = async (filters: RunFilters = {}): Promise<ScreenshotRun[]> =>
  (await api.get<ScreenshotRun[]>('/runs', { params: filters })).data
export const getRun = async (id: string): Promise<ScreenshotRun> =>
  (await api.get<ScreenshotRun>(`/runs/${id}`)).data
export const reviewRun = async (id: string, payload: ReviewPayload): Promise<ScreenshotRun> =>
  (await api.patch<ScreenshotRun>(`/runs/${id}/review`, payload)).data
export const mergeRuns = async (ids: string[]): Promise<ScreenshotRun> =>
  (await api.post<ScreenshotRun>('/runs/merge', ids)).data
export const importRuns = async (payload: ImportRunPayload): Promise<ScreenshotRun[]> =>
  (await api.post<ScreenshotRun[]>('/runs/import', payload)).data
export const getBaselines = async (projectId?: string): Promise<Baseline[]> =>
  (await api.get<Baseline[]>('/baselines', { params: { projectId } })).data
export const getRules = async (): Promise<IgnoreRule[]> =>
  (await api.get<IgnoreRule[]>('/rules')).data
export const createRule = async (
  payload: Omit<IgnoreRule, 'id' | 'createdAt' | 'revision'>,
): Promise<IgnoreRule> => (await api.post<IgnoreRule>('/rules', payload)).data
export const toggleRule = async (id: string, enabled: boolean): Promise<IgnoreRule> =>
  (await api.patch<IgnoreRule>(`/rules/${id}`, { enabled })).data
export const deleteRule = async (id: string): Promise<{ success: boolean }> =>
  (await api.delete<{ success: boolean }>(`/rules/${id}`)).data

export const getBatches = async (): Promise<ApprovalBatch[]> =>
  (await api.get<ApprovalBatch[]>('/batches')).data
export const createBatch = async (payload: CreateBatchPayload): Promise<BatchDetail> =>
  (await api.post<BatchDetail>('/batches', payload)).data
export const getBatch = async (id: string, windowId: string): Promise<BatchDetail> =>
  (await api.get<BatchDetail>(`/batches/${id}`, { params: { windowId } })).data
export const abandonBatch = async (id: string): Promise<{ success: boolean }> =>
  (await api.delete<{ success: boolean }>(`/batches/${id}`)).data
export const acquireLock = async (id: string, payload: LockPayload): Promise<BatchDetail> =>
  (await api.post<BatchDetail>(`/batches/${id}/lock`, payload)).data
export const heartbeat = async (id: string, payload: LockPayload): Promise<LockInfo> =>
  (await api.post<LockInfo>(`/batches/${id}/heartbeat`, payload)).data
export const releaseLock = async (id: string, payload: LockPayload): Promise<{ success: boolean }> =>
  (await api.post(`/batches/${id}/unlock`, payload)).data
export const saveDraft = async (id: string, payload: SaveDraftPayload): Promise<BatchDraft> =>
  (await api.post<BatchDraft>(`/batches/${id}/drafts`, payload)).data
export const reviewBatchItem = async (
  id: string,
  runId: string,
  payload: BatchItemReviewPayload,
): Promise<BatchDetail> =>
  (await api.post<BatchDetail>(`/batches/${id}/items/${runId}/review`, payload)).data
export const refreezeItem = async (id: string, runId: string, payload: LockPayload): Promise<BatchDetail> =>
  (await api.post<BatchDetail>(`/batches/${id}/items/${runId}/refreeze`, payload)).data
export const recaptureItem = async (
  id: string,
  runId: string,
  payload: LockPayload,
): Promise<BatchDetail> =>
  (await api.post<BatchDetail>(`/batches/${id}/items/${runId}/recapture`, payload)).data
export const completeBatch = async (id: string, payload: LockPayload): Promise<BatchDetail> =>
  (await api.post<BatchDetail>(`/batches/${id}/complete`, payload)).data
export const armFailNextWrite = async (id: string): Promise<{ armed: boolean }> =>
  (await api.post<{ armed: boolean }>(`/batches/${id}/fail-next-write`)).data
