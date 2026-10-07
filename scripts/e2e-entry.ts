/* 端到端逻辑验证入口（由 e2e-run.cjs 打包执行）。 */

// ---- Node 环境浏览器 shim ----
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value))
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
}
;(globalThis as Record<string, unknown>).localStorage = new MemoryStorage()
;(globalThis as Record<string, unknown>).window = {
  localStorage: (globalThis as Record<string, unknown>).localStorage,
  setTimeout: (fn: () => void) => setTimeout(fn, 0),
}

import { api } from '../src/api/http'
import {
  abandonBatch,
  armFailNextWrite,
  completeBatch,
  createBatch,
  getBaselines,
  getBatch,
  getRuns,
  recaptureItem,
  refreezeItem,
  reviewBatchItem,
  reviewRun,
  saveDraft,
  createRule,
} from '../src/api/http'
import type { BatchDetail, ReviewCategory } from '../src/types'

const WIN_A = { windowId: 'win-A', windowLabel: '窗口A' }
const WIN_B = { windowId: 'win-B', windowLabel: '窗口B' }

let passed = 0
const check = (name: string, condition: boolean, extra = '') => {
  if (!condition) throw new Error(`❌ ${name} ${extra}`)
  passed += 1
  console.log(`  ✓ ${name}`)
}

const reviewForm = (
  overrides: Partial<{
    category: ReviewCategory
    decision: 'approved' | 'rejected'
    reason: string
    reviewer: string
  }> = {},
) => ({
  category: 'design-change' as ReviewCategory,
  decision: 'approved' as const,
  reviewer: '林默',
  reason: '已核对设计稿与验收单，变化符合预期。',
  ignoredRegionIds: [] as string[],
  ...overrides,
})

const itemOf = (detail: BatchDetail, runId: string) =>
  detail.batch.items.find((item) => item.runId === runId)!

const runOf = (detail: BatchDetail, runId: string) =>
  detail.runs.find((run) => run.id === runId)!

async function main() {
  /* ============ 批次一：完整失效 / 复议 / 原子生效（1048 + 1047） ============ */

  console.log('\n[1] 建批次：冻结图指纹与命中规则修订')
  const created = await createBatch({
    name: 'e2e 发布批次一',
    runIds: ['run-1048', 'run-1047'],
    createdBy: '林默',
    ...WIN_A,
  })
  const batchId = created.batch.id
  check('批次包含 2 页', created.batch.items.length === 2)
  check('建批次即取得写锁', created.lock.held === true)
  const item1048 = itemOf(created, 'run-1048')
  check('冻结当前图指纹', item1048.basis.imageFingerprint.startsWith('fp-'))
  check('冻结规则修订 r6', item1048.basis.ruleRevision === 6)
  check('命中规则被快照（rule-time + rule-watermark）', item1048.basis.matchedRules.length === 2)
  check('差异区域被冻结', item1048.basis.regions.length === 3)
  check('1047（iPhone）命中同样的全局规则', itemOf(created, 'run-1047').basis.matchedRules.length === 2)

  console.log('\n[2] 单页结论隔离：只改对应页面，批次生效前不切基线')
  await reviewBatchItem(batchId, 'run-1048', { ...WIN_A, ...reviewForm() })
  let detail = await getBatch(batchId, WIN_A.windowId)
  check('1048 已通过', itemOf(detail, 'run-1048').status === 'approved')
  check('1047 仍待结论', itemOf(detail, 'run-1047').status === 'pending')
  check('通过页运行未提前切基线', runOf(detail, 'run-1048').status === 'pending')
  check('尚无批次基线', !(await getBaselines()).some((b) => b.batchId === batchId))
  check('单页结论留痕依据修订', itemOf(detail, 'run-1048').review?.ruleRevision === 6)

  console.log('\n[3] 跨窗口：B 窗口不能写入，只能存草稿')
  let blocked = false
  try {
    await reviewBatchItem(batchId, 'run-1047', { ...WIN_B, ...reviewForm() })
  } catch {
    blocked = true
  }
  check('B 窗口写入被拒绝', blocked)
  const draft = await saveDraft(batchId, {
    ...WIN_B,
    runId: 'run-1047',
    form: {
      category: 'design-change',
      decision: 'approved',
      reviewer: '周航',
      reason: 'B 窗口的审批意见草稿。',
      ignoredRegionIds: [],
    },
  })
  check('草稿已保存', Boolean(draft.savedAt))
  check('草稿携带已变化页面清单', Array.isArray(draft.changedPages))

  console.log('\n[4] 规则变化：命中页立即失效，原结论保留并列复议项')
  // rule-time 全局命中，改其色差 → 两页失效
  await api.patch('/rules/rule-time', { maxDelta: 42 })
  detail = await getBatch(batchId, WIN_A.windowId)
  const stale1048 = itemOf(detail, 'run-1048')
  check('1048 依据失效', stale1048.validity === 'stale')
  check('1048 回到待结论', stale1048.status === 'pending')
  check('原结论已归档为复议项', stale1048.reconsiderLog.length === 1)
  check('复议项保留原审批原因', (stale1048.reconsiderLog[0].review?.reason ?? '').includes('设计稿'))
  check('失效原因为规则变化', stale1048.staleReasons?.[0].kind === 'rules')
  check('同批次的 1047 也被同一条规则命中而失效', itemOf(detail, 'run-1047').validity === 'stale')

  console.log('\n[5] 存在失效页 → 不允许生效')
  let blockedComplete = false
  try {
    await completeBatch(batchId, WIN_A)
  } catch (error) {
    blockedComplete = /失效/.test((error as Error).message)
  }
  check('生效被拒绝', blockedComplete)

  console.log('\n[6] 复议重冻：以当前规则为新依据，再重新审批')
  await refreezeItem(batchId, 'run-1048', WIN_A)
  await refreezeItem(batchId, 'run-1047', WIN_A)
  detail = await getBatch(batchId, WIN_A.windowId)
  check('复议后依据恢复有效', detail.batch.items.every((item) => item.validity === 'fresh'))
  check('复议项仍保留可追溯', itemOf(detail, 'run-1048').reconsiderLog.length === 1)
  await reviewBatchItem(batchId, 'run-1048', {
    ...WIN_A,
    ...reviewForm({ reason: '复议后确认色差调整可接受，批准。' }),
  })

  console.log('\n[7] 无关规则修订：未命中页自动对齐，依据不失效')
  await createRule({
    name: 'e2e 增长平台专用规则',
    projectId: 'p-growth',
    selector: '.growth-only',
    pagePattern: '*',
    devicePattern: '*',
    maxDelta: 3,
    enabled: true,
  })
  detail = await getBatch(batchId, WIN_A.windowId)
  check('两页均仍有效', detail.batch.items.every((item) => item.validity === 'fresh'))
  check('全部页面依据已对齐到最新修订', detail.batch.items.every((item) => item.basis.ruleRevision === detail.batch.ruleRevision))
  check('对齐动作留痕', itemOf(detail, 'run-1048').basis.alignmentLog.length >= 1)

  console.log('\n[8] 截图被换：指纹变化立即失效，失效页禁止提交')
  await reviewBatchItem(batchId, 'run-1047', { ...WIN_A, ...reviewForm() })
  await recaptureItem(batchId, 'run-1047', WIN_A)
  detail = await getBatch(batchId, WIN_A.windowId)
  const stale1047 = itemOf(detail, 'run-1047')
  check('1047 换图后失效', stale1047.validity === 'stale')
  check('失效原因含截图指纹', stale1047.staleReasons?.some((r) => r.kind === 'screenshot') ?? false)
  check('原结论进入复议项（含规则、截图两次）', stale1047.reconsiderLog.length === 2)
  check('最近一次复议项保留原审批原因', (stale1047.reconsiderLog[1].review?.reason ?? '').includes('设计稿'))
  let staleBlocked = false
  try {
    await reviewBatchItem(batchId, 'run-1047', { ...WIN_A, ...reviewForm() })
  } catch {
    staleBlocked = true
  }
  check('失效页审批被拒绝', staleBlocked)
  await refreezeItem(batchId, 'run-1047', WIN_A)
  await reviewBatchItem(batchId, 'run-1047', {
    ...WIN_A,
    ...reviewForm({ reason: '新截图已核对，无渲染异常，批准。' }),
  })

  console.log('\n[9] 同修订齐全 → 原子切换有效基线')
  detail = await getBatch(batchId, WIN_A.windowId)
  check('生效前无失效/待结论页', detail.batch.items.every((i) => i.status === 'approved' && i.validity === 'fresh'))
  await completeBatch(batchId, WIN_A)
  detail = await getBatch(batchId, WIN_A.windowId)
  check('批次已完成', detail.batch.status === 'completed')
  check('记录统一生效修订', detail.batch.committedRuleRevision === detail.batch.ruleRevision)
  check('产生 2 条批次基线', (detail.batch.promotedBaselineIds ?? []).length === 2)
  const afterBaselines = await getBaselines()
  const batchBaselines = afterBaselines.filter((b) => b.batchId === batchId && b.active)
  check('两条新基线均有效', batchBaselines.length === 2)
  check('旧基线被停用', !afterBaselines.find((b) => b.id === 'base-commerce-checkout')?.active)
  check('新基线记录统一修订', batchBaselines.every((b) => b.ruleRevision === detail.batch.ruleRevision))
  check('运行标记为已批准', (await getRuns()).find((r) => r.id === 'run-1048')?.status === 'approved')
  check('完成后写锁释放', detail.lock.lock === undefined && detail.lock.held === false)

  console.log('\n[10] 完成后重复触发：幂等，不重复新增基线')
  const baselineCountBefore = (await getBaselines()).length
  await completeBatch(batchId, WIN_A)
  check('基线数量不增长', (await getBaselines()).length === baselineCountBefore)

  /* ============ 批次二：写入失败 → 检查点恢复（1044 + 1043） ============ */

  console.log('\n[11] 写入失败：从已通过页检查点恢复，重放不重复')
  const second = await createBatch({
    name: 'e2e 恢复演练批次',
    runIds: ['run-1044', 'run-1043'],
    createdBy: '林默',
    ...WIN_A,
  })
  const id2 = second.batch.id
  await reviewBatchItem(id2, 'run-1044', { ...WIN_A, ...reviewForm() })
  await reviewBatchItem(id2, 'run-1043', { ...WIN_A, ...reviewForm() })
  await armFailNextWrite(id2)
  let crashed = false
  try {
    await completeBatch(id2, WIN_A)
  } catch (error) {
    crashed = /写入失败/.test((error as Error).message)
  }
  check('生效过程报错中断', crashed)
  let d2 = await getBatch(id2, WIN_A.windowId)
  check('批次回到开放状态', d2.batch.status === 'open')
  check('留下失败说明', Boolean(d2.batch.failureNote))
  check('第一页检查点已落库', Boolean(d2.batch.items.find((i) => i.runId === 'run-1044')?.checkpoint?.baselineId))
  const partialBaselines = (await getBaselines()).filter((b) => b.batchId === id2)
  check('部分基线已落盘（恰好 1 条）', partialBaselines.length === 1)

  await completeBatch(id2, WIN_A)
  d2 = await getBatch(id2, WIN_A.windowId)
  check('恢复后批次完成', d2.batch.status === 'completed')
  const finalBaselines = (await getBaselines()).filter((b) => b.batchId === id2)
  check('最终 2 条基线（第一页未重复新增）', finalBaselines.length === 2)
  check('两条均有效', finalBaselines.every((b) => b.active))
  check('两页运行均为已批准', (await getRuns()).filter((r) => ['run-1044', 'run-1043'].includes(r.id)).every((r) => r.status === 'approved'))

  /* ============ 批次三：放弃 + 单页直审保护（再用 1043 / 1044 已批准，改用审批拦截验证） ============ */

  console.log('\n[12] 批次中的页面禁止走单页直审绕过依据；放弃后解锁')
  // 1043/1044 已在完成批次中，此处用仍为 pending 视角验证：新建批次后拦截，放弃后恢复
  // 先重新导入一批待审运行
  const imported = await api.post('/runs/import', {
    projectId: 'p-growth',
    page: 'e2e 临时页',
    device: 'Desktop 1440',
    theme: 'light',
    build: 'e2e/test',
    baselineVersion: 'base-x',
    currentVersion: 'cur-x',
    files: [
      { name: 'a.png', size: 1200, dataUrl: 'data:image/png;base64,AAAA' },
      { name: 'b.png', size: 1300, dataUrl: 'data:image/png;base64,BBBB' },
    ],
  })
  const [runA, runB] = imported.data as Array<{ id: string }>
  const third = await createBatch({
    name: 'e2e 直审保护批次',
    runIds: [runA.id, runB.id],
    createdBy: '林默',
    ...WIN_A,
  })
  let directBlocked = false
  try {
    await reviewRun(runA.id, {
      category: 'design-change',
      decision: 'approved',
      reviewer: '林默',
      reason: '试图绕过批次直接批准。',
    })
  } catch {
    directBlocked = true
  }
  check('单页直审被批次拦截', directBlocked)
  await abandonBatch(third.batch.id)
  const runs = await getRuns()
  check('放弃后运行解除批次归属', !runs.find((r) => r.id === runA.id)?.batchId)

  console.log('\n[13] 写锁：完成/放弃之外，其他窗口拿不到锁')
  const fourth = await createBatch({
    name: 'e2e 锁互斥批次',
    runIds: [runA.id, runB.id],
    createdBy: '林默',
    ...WIN_A,
  })
  let lockBlocked = false
  try {
    await api.post(`/batches/${fourth.batch.id}/lock`, WIN_B)
  } catch {
    lockBlocked = true
  }
  check('B 窗口抢锁被拒绝', lockBlocked)
  await abandonBatch(fourth.batch.id)

  console.log(`\n全部 ${passed} 项断言通过 ✅`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
