import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { readDb, writeDb } from '@/mocks/db'
import {
  matchedRulesForRun,
  regionFingerprint,
  ruleRevisionOf,
  stableHash,
  rulesetRevision,
  runImageFingerprint,
} from '@/utils/evidence'
import type {
  ApprovalBatch,
  Baseline,
  BatchDraftPayload,
  BatchLock,
  CommitBatchPayload,
  CommitResult,
  CreateBatchPayload,
  DashboardData,
  IgnoreRule,
  ImportRunPayload,
  LockConflictData,
  PageDecisionPayload,
  Project,
  RecoverBatchPayload,
  ReviewItem,
  ReviewPayload,
  RunFilters,
  ScreenshotRun,
} from '@/types'

export const api = axios.create({
  baseURL: '/mock-api',
  timeout: 8000,
  headers: { 'Content-Type': 'application/json' },
})

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

const LOCK_TTL_MS = 15_000

const freshLock = (lock?: BatchLock): BatchLock | undefined => {
  if (!lock) return undefined
  if (Date.now() >= new Date(lock.expiresAt).getTime()) return undefined
  return lock
}

/** 写入前置校验：只有持锁窗口可以写入，否则返回 409 冲突数据 */
const assertWritable = (
  db: ReturnType<typeof readDb>,
  batchId: string,
  windowId: string,
): void => {
  const lock = freshLock(db.locks[batchId])
  if (lock && lock.windowId !== windowId) {
    const conflict: LockConflictData = { code: 'LOCK_HELD', lock }
    throw Object.assign(new Error(`写入锁正由 ${lock.windowLabel} 持有，本窗口已转为草稿模式`), {
      status: 409,
      data: conflict,
    })
  }
}

const touchLock = (db: ReturnType<typeof readDb>, batchId: string, windowId: string) => {
  const lock = freshLock(db.locks[batchId])
  if (lock?.windowId === windowId) {
    lock.expiresAt = new Date(Date.now() + LOCK_TTL_MS).toISOString()
  }
}

const nowIso = () => new Date().toISOString()

/**
 * 规则修订变化后让受影响页面立即失效待审：
 * 命中集合变化、或命中规则内容修订变化均触发；已完成页保留原依据并列入复议项。
 */
const invalidateAffectedByRules = (
  db: ReturnType<typeof readDb>,
  changedRuleIds: string[],
): number => {
  let affected = 0
  const currentRevision = rulesetRevision(db.rules)
  db.batches
    .filter((batch) => batch.status === 'open')
    .forEach((batch) => {
      batch.pages.forEach((page) => {
        const run = db.runs.find((item) => item.id === page.runId)
        if (!run) return
        const nowMatchedRules = matchedRulesForRun(run, db.rules)
        const nowMatched = new Set(nowMatchedRules.map((rule) => rule.id))
        const beforeMatched = new Set(page.matchedRules.map((rule) => rule.id))
        const sameSet =
          beforeMatched.size === nowMatched.size &&
          [...nowMatched].every((id) => beforeMatched.has(id))

        // 命中规则中有任意一条内容修订发生变化（如色差阈值、选择器、启用态）
        const touchedMatched = changedRuleIds.some((id) => {
          if (!beforeMatched.has(id) && !nowMatched.has(id)) return false
          const snapshot = page.matchedRules.find((rule) => rule.id === id)
          const latest = nowMatchedRules.find((rule) => rule.id === id)
          if (!snapshot || !latest) return true // 新增命中或取消命中
          return snapshot.revision !== ruleRevisionOf(latest)
        })

        if (sameSet && !touchedMatched) return

        if (
          page.reviewItems.some(
            (item) => item.kind === 'rule-revision' && !item.resolvedAt,
          )
        ) {
          return
        }
        const detailParts = []
        if (!sameSet) {
          detailParts.push(
            `命中集合：${[...beforeMatched].join('、') || '空'} → ${[...nowMatched].join('、') || '空'}`,
          )
        }
        if (touchedMatched) detailParts.push('命中规则内容（选择器/阈值/启用态）已修改')
        const item: ReviewItem = {
          id: `ri-${batch.id}-${page.runId}-rule-${Date.now()}-${affected}`,
          kind: 'rule-revision',
          detail: `命中规则修订已由 r${page.ruleRevision} 变为 r${currentRevision}；${detailParts.join('；')}`,
          previousDecision: page.decision ? { ...page.decision } : undefined,
          createdAt: nowIso(),
        }
        page.reviewItems.push(item)
        page.status = 'invalidated'
        affected += 1
      })
    })
  return affected
}

/** 当前图被另一窗口重拍/替换：引用该运行的打开批次页面立即失效 */
const invalidateAffectedByScreenshot = (
  db: ReturnType<typeof readDb>,
  runId: string,
  previousFingerprint: string,
): number => {
  let affected = 0
  db.batches
    .filter((batch) => batch.status === 'open')
    .forEach((batch) => {
      batch.pages
        .filter((page) => page.runId === runId && page.imageFingerprint === previousFingerprint)
        .forEach((page) => {
          if (
            page.reviewItems.some(
              (item) => item.kind === 'screenshot' && !item.resolvedAt,
            )
          ) {
            return
          }
          page.reviewItems.push({
            id: `ri-${batch.id}-${page.runId}-shot-${Date.now()}`,
            kind: 'screenshot',
            detail: `当前图指纹由 ${previousFingerprint.slice(0, 14)}… 变为 ${runImageFingerprint(
              db.runs.find((run) => run.id === runId)!,
            ).slice(0, 14)}…，原截图已被另一窗口替换`,
            previousDecision: page.decision ? { ...page.decision } : undefined,
            createdAt: nowIso(),
          })
          page.status = 'invalidated'
          affected += 1
        })
    })
  return affected
}

const findBatch = (db: ReturnType<typeof readDb>, batchId: string) =>
  db.batches.find((batch) => batch.id === batchId)

/** 提交前检查：所有页面必须有结论且依据对齐到同一规则修订 */
const commitGuard = (batch: ApprovalBatch, currentRevision: number): string | null => {
  if (batch.status !== 'open') return '批次已结束，不能重复提交'
  const pending = batch.pages.filter((page) => page.status === 'pending')
  if (pending.length > 0) return `仍有 ${pending.length} 个页面未给出单页结论`
  const invalidated = batch.pages.filter((page) => page.status === 'invalidated')
  if (invalidated.length > 0) return `${invalidated.length} 个页面依据已变化，必须完成复议后才能提交`
  const rejected = batch.pages.filter((page) => page.status === 'rejected')
  if (rejected.length > 0) {
    return `${rejected.length} 个页面已驳回，需改为批准或撤出本批次后才能整批切换基线`
  }
  const staleRevision = batch.pages.filter((page) => page.ruleRevision !== currentRevision)
  if (staleRevision.length > 0) {
    return `各页依据未对齐到同一规则修订（当前 r${currentRevision}），请逐页复议`
  }
  const staleShot = batch.pages.filter(
    (page) => page.imageFingerprint !== runImageFingerprintOf(page.runId),
  )
  if (staleShot.length > 0) return `${staleShot.length} 个页面的当前图与建批次时不一致`
  return null
}

// 延迟引用 readDb 的指纹查询，避免循环依赖问题
const runImageFingerprintOf = (runId: string): string => {
  const run = readDb().runs.find((item) => item.id === runId)
  return run ? runImageFingerprint(run) : ''
}


const mockAdapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => window.setTimeout(resolve, 180))
  const db = readDb()
  const method = (config.method ?? 'get').toLowerCase()
  const path = config.url ?? ''

  if (method === 'get' && path === '/projects') {
    return respond<Project[]>(config, db.projects)
  }

  if (method === 'get' && path === '/dashboard') {
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

  const reviewMatch = path.match(/^\/runs\/([^/]+)\/review$/)
  if (method === 'patch' && reviewMatch) {
    const payload = parseBody<ReviewPayload>(config)
    const run = db.runs.find((item) => item.id === reviewMatch[1])
    if (!run) throw new Error('运行记录不存在')
    run.status = payload.decision
    run.review = {
      ...payload,
      reviewedAt: new Date().toISOString(),
    }
    if (payload.decision === 'approved') {
      const baseline = db.baselines.find(
        (item) =>
          item.projectId === run.projectId &&
          item.page === run.page &&
          item.device === run.device &&
          item.theme === run.theme &&
          item.active,
      )
      if (baseline) baseline.active = false
      db.baselines.unshift({
        id: `base-${Date.now()}`,
        projectId: run.projectId,
        page: run.page,
        device: run.device,
        theme: run.theme,
        version: run.currentVersion,
        approvedBy: payload.reviewer,
        reason: payload.reason,
        approvedAt: new Date().toISOString(),
        runId: run.id,
        active: true,
      })
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
    const imported = payload.files.map((file, index) => {
      const runId = `run-${Date.now()}-${index + 1}`
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
        capturedAt: new Date().toISOString(),
        baselineVersion: payload.baselineVersion.trim() || '当前有效基线',
        currentVersion: payload.currentVersion.trim() || payload.build.trim(),
        baselineImage: payload.baselineImage,
        currentImage: file.dataUrl,
        imageFingerprint: `img-${Date.now().toString(36)}-${index}-${stableHash(
          file.dataUrl,
        )}`,
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
    const input = parseBody<Omit<IgnoreRule, 'id' | 'createdAt'>>(config)
    const rule: IgnoreRule = {
      ...input,
      id: `rule-${Date.now()}`,
      createdAt: new Date().toISOString(),
    }
    db.rules.unshift(rule)
    invalidateAffectedByRules(db, [rule.id])
    writeDb(db)
    return respond(config, rule, 201)
  }

  const ruleMatch = path.match(/^\/rules\/([^/]+)$/)
  if (method === 'patch' && ruleMatch) {
    const payload = parseBody<Partial<IgnoreRule>>(config)
    const rule = db.rules.find((item) => item.id === ruleMatch[1])
    if (!rule) throw new Error('规则不存在')
    Object.assign(rule, payload)
    invalidateAffectedByRules(db, [rule.id])
    writeDb(db)
    return respond(config, rule)
  }
  if (method === 'delete' && ruleMatch) {
    const index = db.rules.findIndex((item) => item.id === ruleMatch[1])
    if (index < 0) throw new Error('规则不存在')
    const [removed] = db.rules.splice(index, 1)
    invalidateAffectedByRules(db, [removed.id])
    writeDb(db)
    return respond(config, { success: true })
  }

  // ============ 审批批次：同一批准依据 ============

  if (method === 'get' && path === '/batches') {
    const status = config.params?.status as string | undefined
    const withLock = config.params?.lock === '1'
    const data = db.batches
      .filter((batch) => !status || batch.status === status)
      .map((batch) => ({
        ...batch,
        ...(withLock ? { lock: freshLock(db.locks[batch.id]) ?? null } : {}),
      }))
    return respond(config, data)
  }

  const batchMatch = path.match(/^\/batches\/([^/]+)$/)
  if (method === 'get' && batchMatch) {
    const batch = findBatch(db, batchMatch[1])
    if (!batch) throw new Error('批次不存在')
    return respond(config, { ...batch, lock: freshLock(db.locks[batch.id]) ?? null })
  }

  if (method === 'post' && path === '/batches') {
    const payload = parseBody<CreateBatchPayload>(config)
    if (payload.runIds.length < 2) throw new Error('批次至少选择两个页面')
    const selectedRuns = payload.runIds
      .map((id) => db.runs.find((run) => run.id === id))
      .filter((run): run is ScreenshotRun => Boolean(run))
    if (selectedRuns.length !== payload.runIds.length) throw new Error('批次中存在已删除的运行')
    const revision = rulesetRevision(db.rules)
    const batch: ApprovalBatch = {
      id: `batch-${Date.now()}`,
      name: payload.name.trim() || `${payload.release} 基线审批批次`,
      projectId: payload.projectId,
      release: payload.release,
      status: 'open',
      createdAt: nowIso(),
      createdBy: payload.createdBy,
      ruleRevision: revision,
      pages: selectedRuns.map((run) => ({
        runId: run.id,
        page: run.page,
        device: run.device,
        theme: run.theme,
        imageFingerprint: runImageFingerprint(run),
        ruleRevision: revision,
        matchedRules: matchedRulesForRun(run, db.rules).map((rule) => ({
          id: rule.id,
          revision: ruleRevisionOf(rule),
        })),
        regionFingerprint: regionFingerprint(run.regions),
        status: 'pending' as const,
        reviewItems: [],
      })),
      drafts: [],
    }
    db.batches.unshift(batch)
    writeDb(db)
    return respond(config, { ...batch, lock: null }, 201)
  }

  // 模拟“另一窗口重拍/替换当前图”
  const recaptureMatch = path.match(/^\/runs\/([^/]+)\/recapture$/)
  if (method === 'post' && recaptureMatch) {
    const run = db.runs.find((item) => item.id === recaptureMatch[1])
    if (!run) throw new Error('运行记录不存在')
    const previous = runImageFingerprint(run)
    run.imageFingerprint = `img-${Date.now().toString(36)}-${stableHash(run.id + Math.random())}`
    run.capturedAt = nowIso()
    const affected = invalidateAffectedByScreenshot(db, run.id, previous)
    writeDb(db)
    return respond(config, { runId: run.id, fingerprint: run.imageFingerprint, affected })
  }

  // ---- 跨窗口单写锁 ----
  const lockMatch = path.match(/^\/batches\/([^/]+)\/lock$/)
  if (method === 'post' && lockMatch) {
    const payload = parseBody<{ windowId: string; windowLabel: string }>(config)
    const batchId = lockMatch[1]
    if (!findBatch(db, batchId)) throw new Error('批次不存在')
    const existing = freshLock(db.locks[batchId])
    if (existing && existing.windowId !== payload.windowId) {
      return respond(config, { acquired: false, lock: existing }, 409)
    }
    const lock: BatchLock = {
      windowId: payload.windowId,
      windowLabel: payload.windowLabel,
      acquiredAt: existing?.acquiredAt ?? nowIso(),
      expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
    }
    db.locks[batchId] = lock
    writeDb(db)
    return respond(config, { acquired: true, lock })
  }
  if (method === 'delete' && lockMatch) {
    const payload = parseBody<{ windowId: string }>(config)
    const existing = freshLock(db.locks[lockMatch[1]])
    if (existing?.windowId === payload.windowId) delete db.locks[lockMatch[1]]
    writeDb(db)
    return respond(config, { released: true })
  }

  // ---- 单页结论：只改对应页面，依据变化时重新锚定 ----
  const decisionMatch = path.match(/^\/batches\/([^/]+)\/pages\/([^/]+)\/decision$/)
  if (method === 'patch' && decisionMatch) {
    const [, batchId, runId] = decisionMatch
    const payload = parseBody<PageDecisionPayload>(config)
    const batch = findBatch(db, batchId)
    if (!batch) throw new Error('批次不存在')
    assertWritable(db, batchId, payload.windowId)

    const page = batch.pages.find((item) => item.runId === runId)
    if (!page) throw new Error('该页面不在批次内')

    // 写入前检查点：失败后只重放未处理的单页审批
    const completedRunIds = batch.pages
      .filter((item) => item.status === 'approved' || item.status === 'rejected')
      .map((item) => item.runId)
    batch.checkpoint = {
      takenAt: nowIso(),
      completedRunIds,
      processedOpIds: batch.checkpoint?.processedOpIds ?? [],
      pendingDecision: { opId: payload.opId, runId, payload },
      pendingBaselineRunIds: batch.checkpoint?.pendingBaselineRunIds ?? [],
    }
    writeDb(db)

    const run = db.runs.find((item) => item.id === runId)!
    const currentRevision = rulesetRevision(db.rules)
    const currentShot = runImageFingerprint(run)
    const currentRegionFingerprint = regionFingerprint(run.regions)
    const reAnchored =
      page.status === 'invalidated' ||
      page.ruleRevision !== currentRevision ||
      page.imageFingerprint !== currentShot ||
      page.regionFingerprint !== currentRegionFingerprint

    page.decision = {
      category: payload.category,
      decision: payload.decision,
      reviewer: payload.reviewer,
      reason: payload.reason,
      decidedAt: nowIso(),
    }
    page.status = payload.decision
    page.ruleRevision = currentRevision
    page.imageFingerprint = currentShot
    page.regionFingerprint = currentRegionFingerprint
    page.matchedRules = matchedRulesForRun(run, db.rules).map((rule) => ({
      id: rule.id,
      revision: ruleRevisionOf(rule),
    }))
    page.reviewItems = page.reviewItems.map((item) =>
      item.resolvedAt ? item : { ...item, resolvedAt: nowIso() },
    )

    // 单页结论不同步创建基线：基线只在整批提交时统一切换
    run.status = payload.decision
    run.review = {
      category: payload.category,
      decision: payload.decision,
      reviewer: payload.reviewer,
      reason: payload.reason,
      reviewedAt: page.decision.decidedAt,
    }

    batch.checkpoint = {
      ...batch.checkpoint,
      pendingDecision: undefined,
      processedOpIds: [...(batch.checkpoint?.processedOpIds ?? []), payload.opId],
    }
    touchLock(db, batchId, payload.windowId)
    writeDb(db)
    return respond(config, { batch, reAnchored, lock: freshLock(db.locks[batchId]) ?? null })
  }

  // ---- 非持锁窗口保存草稿，并标出已变化页面 ----
  const draftMatch = path.match(/^\/batches\/([^/]+)\/drafts$/)
  if (method === 'post' && draftMatch) {
    const payload = parseBody<BatchDraftPayload>(config)
    const batch = findBatch(db, draftMatch[1])
    if (!batch) throw new Error('批次不存在')
    const currentRevision = rulesetRevision(db.rules)
    const changedPages = batch.pages
      .filter((item) => item.ruleRevision !== currentRevision || item.status === 'invalidated')
      .map((item) => item.runId)
    const draft = {
      id: `draft-${Date.now()}`,
      batchId: batch.id,
      ...payload,
      changedPages,
      savedAt: nowIso(),
    }
    batch.drafts.push(draft)
    writeDb(db)
    return respond(config, draft, 201)
  }

  const draftItemMatch = path.match(/^\/batches\/([^/]+)\/drafts\/([^/]+)$/)
  if (method === 'delete' && draftItemMatch) {
    const batch = findBatch(db, draftItemMatch[1])
    if (!batch) throw new Error('批次不存在')
    batch.drafts = batch.drafts.filter((draft) => draft.id !== draftItemMatch[2])
    writeDb(db)
    return respond(config, { success: true })
  }

  // 幂等重放中断的单页结论，不重复新增审批
  const replayPendingDecision = (
    batch: ApprovalBatch,
    currentRevision: number,
  ): { replayed: boolean } => {
    const checkpoint = batch.checkpoint
    if (!checkpoint?.pendingDecision) return { replayed: false }
    const { opId, runId, payload } = checkpoint.pendingDecision
    if (checkpoint.processedOpIds.includes(opId)) return { replayed: false }
    const page = batch.pages.find((item) => item.runId === runId)
    const run = db.runs.find((item) => item.id === runId)
    if (!page || !run) return { replayed: false }
    page.decision = { ...payload, decidedAt: nowIso() }
    page.status = payload.decision
    page.ruleRevision = currentRevision
    page.imageFingerprint = runImageFingerprint(run)
    page.regionFingerprint = regionFingerprint(run.regions)
    page.reviewItems = page.reviewItems.map((item) =>
      item.resolvedAt ? item : { ...item, resolvedAt: nowIso() },
    )
    run.status = payload.decision
    run.review = {
      category: payload.category,
      decision: payload.decision,
      reviewer: payload.reviewer,
      reason: payload.reason,
      reviewedAt: page.decision.decidedAt,
    }
    checkpoint.processedOpIds.push(opId)
    checkpoint.pendingDecision = undefined
    return { replayed: true }
  }

  // 幂等切换批准页基线：同批次同运行已有基线则跳过，不重复新增
  const switchApprovedBaselines = (batch: ApprovalBatch): Baseline[] => {
    const created: Baseline[] = []
    batch.pages
      .filter((page) => page.status === 'approved')
      .forEach((page) => {
        const existing = db.baselines.find(
          (item) => item.batchId === batch.id && item.runId === page.runId,
        )
        if (existing) {
          created.push(existing)
          return
        }
        const run = db.runs.find((item) => item.id === page.runId)!
        db.baselines.forEach((item) => {
          if (
            item.projectId === run.projectId &&
            item.page === run.page &&
            item.device === run.device &&
            item.theme === run.theme &&
            item.active
          ) {
            item.active = false
          }
        })
        const baseline: Baseline = {
          id: `base-${Date.now()}-${page.runId}`,
          projectId: run.projectId,
          page: run.page,
          device: run.device,
          theme: run.theme,
          version: run.currentVersion,
          approvedBy: page.decision?.reviewer ?? batch.createdBy,
          reason: page.decision?.reason ?? '批次统一切换',
          approvedAt: nowIso(),
          runId: run.id,
          active: true,
          batchId: batch.id,
        }
        db.baselines.unshift(baseline)
        created.push(baseline)
      })
    return created
  }

  const finalizeBatch = (batch: ApprovalBatch, baselines: Baseline[], replayed: boolean) => {
    batch.status = 'committed'
    batch.committedAt = nowIso()
    batch.baselineIds = baselines.map((item) => item.id)
    batch.checkpoint = undefined
    delete db.locks[batch.id]
    const result: CommitResult = { batch, baselines, replayed: replayed ? 1 : 0 }
    writeDb(db)
    return result
  }

  // ---- 整批提交：全部通过且依据同一修订后才切换有效基线 ----
  const commitMatch = path.match(/^\/batches\/([^/]+)\/commit$/)
  if (method === 'post' && commitMatch) {
    const payload = parseBody<CommitBatchPayload>(config)
    const batch = findBatch(db, commitMatch[1])
    if (!batch) throw new Error('批次不存在')
    assertWritable(db, batch.id, payload.windowId)

    const currentRevision = rulesetRevision(db.rules)
    const guardError = commitGuard(batch, currentRevision)
    if (guardError) throw new Error(guardError)

    // 恢复路径：先幂等重放中断的单页审批
    const replay = replayPendingDecision(batch, currentRevision)
    const secondGuard = commitGuard(batch, currentRevision)
    if (secondGuard) throw new Error(secondGuard)

    // 基线切换检查点：记录已通过页面，写入失败后从检查点恢复
    const wasFailing = Boolean(batch.checkpoint?.failedAt)
    if (!batch.checkpoint) {
      batch.checkpoint = {
        takenAt: nowIso(),
        completedRunIds: batch.pages
          .filter((page) => page.status === 'approved' || page.status === 'rejected')
          .map((page) => page.runId),
        processedOpIds: [],
        pendingBaselineRunIds: batch.pages
          .filter((page) => page.status === 'approved')
          .map((page) => page.runId),
      }
    }
    if (payload.forceFail && !wasFailing) {
      batch.checkpoint.failedAt = nowIso()
      batch.checkpoint.failReason = '基线写入中断（演示）'
      writeDb(db)
      throw Object.assign(
        new Error('基线写入中断：已保留已通过页面检查点，可从检查点恢复'),
        { status: 500 },
      )
    }

    const created = switchApprovedBaselines(batch)
    return respond(config, finalizeBatch(batch, created, replay.replayed))
  }

  // ---- 从已通过页面检查点恢复并重放 ----
  const recoverMatch = path.match(/^\/batches\/([^/]+)\/recover$/)
  if (method === 'post' && recoverMatch) {
    const payload = parseBody<RecoverBatchPayload>(config)
    const batch = findBatch(db, recoverMatch[1])
    if (!batch) throw new Error('批次不存在')
    assertWritable(db, batch.id, payload.windowId)
    if (!batch.checkpoint?.failedAt) throw new Error('该批次没有可恢复的检查点')

    const currentRevision = rulesetRevision(db.rules)
    const replay = replayPendingDecision(batch, currentRevision)
    const guardError = commitGuard(batch, currentRevision)
    if (guardError) throw new Error(guardError)

    // 已写入的基线幂等跳过，只补齐检查点中未完成的批准页
    const created = switchApprovedBaselines(batch)
    return respond(config, finalizeBatch(batch, created, replay.replayed))
  }

  throw new Error(`Mock API 未实现：${method.toUpperCase()} ${path}`)
}

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
  payload: Omit<IgnoreRule, 'id' | 'createdAt'>,
): Promise<IgnoreRule> => (await api.post<IgnoreRule>('/rules', payload)).data
export const toggleRule = async (id: string, enabled: boolean): Promise<IgnoreRule> =>
  (await api.patch<IgnoreRule>(`/rules/${id}`, { enabled })).data
export const deleteRule = async (id: string): Promise<{ success: boolean }> =>
  (await api.delete<{ success: boolean }>(`/rules/${id}`)).data

// ============ 审批批次 ============

export type BatchDetail = ApprovalBatch & { lock: BatchLock | null }

export const getBatches = async (status?: string): Promise<BatchDetail[]> =>
  (await api.get<BatchDetail[]>('/batches', { params: { status, lock: '1' } })).data
export const getBatch = async (id: string): Promise<BatchDetail> =>
  (await api.get<BatchDetail>(`/batches/${id}`)).data
export const createBatch = async (payload: CreateBatchPayload): Promise<BatchDetail> =>
  (await api.post<BatchDetail>('/batches', payload)).data
export const decideBatchPage = async (
  batchId: string,
  runId: string,
  payload: PageDecisionPayload,
): Promise<{ batch: ApprovalBatch; reAnchored: boolean; lock: BatchLock | null }> =>
  (await api.patch(`/batches/${batchId}/pages/${runId}/decision`, payload)).data
export const commitBatch = async (
  batchId: string,
  payload: CommitBatchPayload,
): Promise<CommitResult> => (await api.post<CommitResult>(`/batches/${batchId}/commit`, payload)).data
export const recoverBatch = async (
  batchId: string,
  payload: RecoverBatchPayload,
): Promise<CommitResult> => (await api.post<CommitResult>(`/batches/${batchId}/recover`, payload)).data
export const saveBatchDraft = async (
  batchId: string,
  payload: BatchDraftPayload,
) => (await api.post(`/batches/${batchId}/drafts`, payload)).data
export const deleteBatchDraft = async (batchId: string, draftId: string) =>
  (await api.delete(`/batches/${batchId}/drafts/${draftId}`)).data
export const acquireBatchLock = async (
  batchId: string,
  payload: { windowId: string; windowLabel: string },
): Promise<{ acquired: boolean; lock: BatchLock }> =>
  (await api.post(`/batches/${batchId}/lock`, payload)).data
export const releaseBatchLock = async (batchId: string, windowId: string) =>
  (await api.delete(`/batches/${batchId}/lock`, { data: { windowId } })).data
export const recaptureRun = async (
  runId: string,
): Promise<{ runId: string; fingerprint: string; affected: number }> =>
  (await api.post(`/runs/${runId}/recapture`)).data
