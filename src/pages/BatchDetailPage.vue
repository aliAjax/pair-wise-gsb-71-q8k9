<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import DiffCanvas from '@/components/DiffCanvas.vue'
import {
  acquireLock,
  armFailNextWrite,
  completeBatch,
  getBatch,
  recaptureItem,
  refreezeItem,
  reviewBatchItem,
  saveDraft,
} from '@/api/http'
import {
  lockPayload,
  releaseBatch,
  startHeartbeat,
  stopHeartbeat,
  windowLabel,
} from '@/utils/windowSession'
import { shortFingerprint } from '@/utils/basis'
import type { BatchItem, DifferenceRegion, ReviewCategory, ScreenshotRun } from '@/types'

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const batchId = computed(() => String(route.params.id))

const activeRunId = ref('')
const localRegions = ref<DifferenceRegion[]>([])

const form = reactive({
  category: 'design-change' as ReviewCategory,
  decision: 'approved' as 'approved' | 'rejected',
  reviewer: '林默',
  reason: '',
})

const { data: detail, isLoading } = useQuery({
  queryKey: computed(() => ['batch', batchId.value, windowLabel]),
  queryFn: () => getBatch(batchId.value, lockPayload().windowId),
  refetchInterval: 4000,
})

const batch = computed(() => detail.value?.batch)
const held = computed(() => Boolean(detail.value?.lock.held))
const lockedByOther = computed(() => Boolean(detail.value?.lock.lock && !held.value))

const runsById = computed(() => {
  const map = new Map<string, ScreenshotRun>()
  for (const run of detail.value?.runs ?? []) map.set(run.id, run)
  return map
})

const activeItem = computed<BatchItem | undefined>(() =>
  batch.value?.items.find((item) => item.runId === activeRunId.value),
)
const activeRun = computed(() => runsById.value.get(activeRunId.value))

const visibleRegions = computed(() => localRegions.value)

const selectPage = (runId: string) => {
  activeRunId.value = runId
}

watch(
  [activeRunId, detail],
  () => {
    const item = activeItem.value
    const run = activeRun.value
    if (!item || !run) return
    // 已冻结的忽略区域以依据快照为准，保证结论与依据一致。
    localRegions.value = item.basis.regions.map((region) => ({ ...region }))
    if (item.review) {
      form.category = item.review.category
      form.decision = item.review.decision
      form.reviewer = item.review.reviewer
      form.reason = item.review.reason
    } else if (!form.reason) {
      form.category = 'design-change'
      form.decision = 'approved'
    }
  },
  { immediate: true },
)

watch(
  batch,
  (value) => {
    if (value && !activeRunId.value && value.items[0]) activeRunId.value = value.items[0].runId
    if (value && held.value) startHeartbeat(value.id)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  stopHeartbeat(batchId.value)
})

const invalidate = async () => {
  await queryClient.invalidateQueries({ queryKey: ['batch', batchId.value] })
  await queryClient.invalidateQueries({ queryKey: ['batches'] })
  await queryClient.invalidateQueries({ queryKey: ['runs'] })
  await queryClient.invalidateQueries({ queryKey: ['baselines'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
}

const lockMutation = useMutation({
  mutationFn: () => acquireLock(batchId.value, lockPayload()),
  onSuccess: async () => {
    Message.success('已取得写入锁，其他窗口将转为草稿模式')
    startHeartbeat(batchId.value)
    await invalidate()
  },
  onError: (error: Error) => Message.error(error.message),
})

const reviewMutation = useMutation({
  mutationFn: () =>
    reviewBatchItem(batchId.value, activeRunId.value, {
      ...lockPayload(),
      category: form.category,
      decision: form.decision,
      reviewer: form.reviewer,
      reason: form.reason,
      ignoredRegionIds: localRegions.value.filter((region) => region.ignored).map((region) => region.id),
    }),
  onSuccess: async () => {
    Message.success('单页结论已记录，仅影响该页面；批次生效前不切换基线')
    await invalidate()
  },
  onError: (error: Error) => Message.error(error.message),
})

const refreezeMutation = useMutation({
  mutationFn: () => refreezeItem(batchId.value, activeRunId.value, lockPayload()),
  onSuccess: async () => {
    Message.success('已按最新截图与规则重新冻结依据，请重新给出该页结论')
    await invalidate()
  },
  onError: (error: Error) => Message.error(error.message),
})

const recaptureMutation = useMutation({
  mutationFn: () => recaptureItem(batchId.value, activeRunId.value, lockPayload()),
  onSuccess: async () => {
    Message.warning('当前图已被替换：该页依据立即失效，原结论保留在复议项中')
    await invalidate()
  },
  onError: (error: Error) => Message.error(error.message),
})

const draftMutation = useMutation({
  mutationFn: () =>
    saveDraft(batchId.value, {
      ...lockPayload(),
      runId: activeRunId.value,
      form: {
        category: form.category,
        decision: form.decision,
        reviewer: form.reviewer,
        reason: form.reason,
        ignoredRegionIds: localRegions.value.filter((region) => region.ignored).map((region) => region.id),
      },
    }),
  onSuccess: (draft) => {
    Message.success(
      draft.changedPages.length > 0
        ? `草稿已保存；检测到 ${draft.changedPages.length} 个页面相比建批次依据已变化`
        : '草稿已保存，未取得写入锁，正式结论未变更',
    )
  },
  onError: (error: Error) => Message.error(error.message),
})

const completeMutation = useMutation({
  mutationFn: () => completeBatch(batchId.value, lockPayload()),
  onSuccess: async () => {
    stopHeartbeat(batchId.value)
    Message.success('全部页面依据同一修订，批次有效基线已一次性切换')
    await invalidate()
  },
  onError: (error: Error) => {
    Message.error(`${error.message} —— 可直接重试，系统会从已通过页面的检查点恢复`)
    void invalidate()
  },
})

const armFailureMutation = useMutation({
  mutationFn: () => armFailNextWrite(batchId.value),
  onSuccess: () => Message.info('已注入下一次生效写入失败，用于验证检查点恢复与重放'),
})

const submitReview = () => {
  if (!form.reason.trim()) {
    Message.warning('请填写审批原因')
    return
  }
  if (activeItem.value?.validity === 'stale') {
    Message.warning('该页依据已失效，请先复议重冻后再提交结论')
    return
  }
  reviewMutation.mutate()
}

const blockers = computed(() => {
  if (!batch.value) return [] as string[]
  const list: string[] = []
  const stale = batch.value.items.filter((item) => item.validity === 'stale').length
  const pending = batch.value.items.filter(
    (item) => item.status !== 'approved' && item.status !== 'rejected',
  ).length
  if (stale > 0) list.push(`${stale} 个页面依据失效待复议`)
  if (pending > 0) list.push(`${pending} 个页面尚未给出结论`)
  const revisions = new Set(batch.value.items.map((item) => item.basis.ruleRevision))
  if (revisions.size !== 1 || [...revisions][0] !== batch.value.ruleRevision) {
    list.push(`各页依据未对齐到当前修订 r${batch.value.ruleRevision}`)
  }
  if (!held.value) list.push('当前窗口未持有写入锁')
  return list
})

const canComplete = computed(() => blockers.value.length === 0 && batch.value?.status === 'open')

const myDrafts = computed(() =>
  (batch.value?.drafts ?? []).filter((draft) => draft.windowId === lockPayload().windowId),
)
const otherDrafts = computed(() =>
  (batch.value?.drafts ?? []).filter((draft) => draft.windowId !== lockPayload().windowId),
)

const applyDraft = (runId: string) => {
  const draft = myDrafts.value.find((item) => item.runId === runId)
  if (!draft) return
  activeRunId.value = runId
  form.category = draft.form.category
  form.decision = draft.form.decision
  form.reviewer = draft.form.reviewer
  form.reason = draft.form.reason
  Message.info('草稿已填入表单，取得写入锁后提交即成为正式结论')
}

const pageStatusLabel = (item: BatchItem) => {
  if (item.validity === 'stale') return { text: '依据失效', color: 'red' }
  if (item.status === 'approved') return { text: '已通过', color: 'green' }
  if (item.status === 'rejected') return { text: '已驳回', color: 'red' }
  return { text: '待结论', color: 'orange' }
}

const toggleIgnored = (region: DifferenceRegion) => {
  const target = localRegions.value.find((item) => item.id === region.id)
  if (target) target.ignored = !target.ignored
}

const handleLeave = async () => {
  await releaseBatch(batchId.value)
  await router.push('/batches')
}
</script>

<template>
  <a-spin :loading="isLoading" style="width: 100%">
    <template v-if="batch && detail">
      <section class="detail-heading">
        <div>
          <a-space>
            <h2>{{ batch.name }}</h2>
            <a-tag :color="batch.status === 'completed' ? 'green' : 'arcoblue'">
              {{ batch.status === 'completed' ? '批次已生效' : batch.status === 'committing' ? '生效中' : '审批中' }}
            </a-tag>
          </a-space>
          <p>
            {{ batch.id }} · 创建人 {{ batch.createdBy }} ·
            冻结于规则修订 <a-tag size="small" color="arcoblue">r{{ batch.ruleRevision }}</a-tag>
            <span v-if="!detail.revisionCurrent" class="danger">（规则集已推进到 r{{ detail.ruleRevision }}）</span>
          </p>
        </div>
        <a-space>
          <a-button @click="handleLeave"><icon-left /> 返回批次列表</a-button>
          <a-button
            v-if="!held && batch.status === 'open'"
            type="primary"
            :loading="lockMutation.isPending.value"
            @click="lockMutation.mutate()"
          >
            <icon-lock /> {{ lockedByOther ? '申请接管写入' : '接管写入' }}
          </a-button>
          <a-tag v-else-if="held" color="green"><icon-check-circle /> {{ windowLabel }} 持有写锁</a-tag>
        </a-space>
      </section>

      <a-alert v-if="lockedByOther" type="warning" style="margin-bottom: 12px">
        批次正由 <b>{{ detail.lock.lock?.windowLabel }}</b> 写入（心跳
        {{ detail.lock.lock?.heartbeatAt.slice(11, 19) }}）。你可以浏览并保存草稿，提交正式结论需等待锁释放。
      </a-alert>
      <a-alert v-if="batch.failureNote" type="error" style="margin-bottom: 12px">
        上次生效写入失败：{{ batch.failureNote }}。已通过页面的检查点完好，点击"检查点恢复并重试"不会重复新增审批或基线。
      </a-alert>

      <div class="batch-progress">
        <div class="progress-item">
          <span>页面总数</span>
          <strong>{{ batch.items.length }}</strong>
        </div>
        <div class="progress-item">
          <span>已通过</span>
          <strong class="ok">{{ batch.items.filter((i) => i.status === 'approved').length }}</strong>
        </div>
        <div class="progress-item">
          <span>已驳回</span>
          <strong class="danger">{{ batch.items.filter((i) => i.status === 'rejected').length }}</strong>
        </div>
        <div class="progress-item">
          <span>依据失效</span>
          <strong :class="{ danger: batch.items.some((i) => i.validity === 'stale') }">
            {{ batch.items.filter((i) => i.validity === 'stale').length }}
          </strong>
        </div>
        <div class="progress-item">
          <span>规则修订</span>
          <strong>r{{ batch.ruleRevision }}</strong>
        </div>
        <div class="progress-spacer" />
        <a-space>
          <a-button
            v-if="batch.status === 'open'"
            size="small"
            :loading="armFailureMutation.isPending.value"
            @click="armFailureMutation.mutate()"
          >
            注入写入失败（演练）
          </a-button>
          <a-button
            type="primary"
            :disabled="!canComplete"
            :loading="completeMutation.isPending.value"
            @click="completeMutation.mutate()"
          >
            <icon-check /> {{ batch.failureNote ? '检查点恢复并重试生效' : '全部通过，统一切换基线' }}
          </a-button>
        </a-space>
      </div>
      <div v-if="blockers.length > 0 && batch.status === 'open'" class="blockers">
        <span>生效前还需：</span>
        <a-tag v-for="blocker in blockers" :key="blocker" color="orange">{{ blocker }}</a-tag>
      </div>

      <div class="batch-workspace">
        <aside class="batch-pages">
          <div class="panel-title">
            <div><h3>批次页面</h3><span>单页结论只改对应页面</span></div>
          </div>
          <button
            v-for="item in batch.items"
            :key="item.runId"
            class="page-row"
            :class="{ active: item.runId === activeRunId, stale: item.validity === 'stale' }"
            @click="selectPage(item.runId)"
          >
            <div class="page-row-main">
              <strong>{{ runsById.get(item.runId)?.page ?? item.runId }}</strong>
              <small>
                图 {{ shortFingerprint(item.basis.imageFingerprint) }} ·
                规则 r{{ item.basis.ruleRevision }} ·
                {{ item.basis.matchedRules.filter((r) => r.enabled).length }} 条命中
              </small>
            </div>
            <a-tag size="small" :color="pageStatusLabel(item).color">{{ pageStatusLabel(item).text }}</a-tag>
          </button>

          <div v-if="myDrafts.length || otherDrafts.length" class="draft-zone">
            <h4>窗口草稿</h4>
            <div v-for="draft in [...myDrafts, ...otherDrafts]" :key="`${draft.windowId}-${draft.runId}`" class="draft-item">
              <div>
                <strong>{{ draft.windowLabel }}</strong>
                <small>
                  {{ runsById.get(draft.runId)?.page ?? draft.runId }} ·
                  {{ draft.savedAt.slice(11, 19) }}
                  <a-tag v-if="draft.changedPages.length" size="small" color="red">
                    标出 {{ draft.changedPages.length }} 页已变化
                  </a-tag>
                </small>
              </div>
              <a-button
                v-if="draft.windowId === lockPayload().windowId && held"
                size="mini"
                type="text"
                @click="applyDraft(draft.runId)"
              >
                载入
              </a-button>
            </div>
          </div>
        </aside>

        <div class="batch-detail" v-if="activeItem && activeRun">
          <div class="comparison-area">
            <div class="basis-strip">
              <div>
                <span>当前图指纹</span>
                <code :class="{ mismatch: activeItem.validity === 'stale' }">
                  {{ shortFingerprint(activeItem.basis.imageFingerprint) }}
                </code>
              </div>
              <div>
                <span>命中规则修订</span>
                <code>r{{ activeItem.basis.ruleRevision }}</code>
              </div>
              <div>
                <span>规则集指纹</span>
                <code>{{ shortFingerprint(activeItem.basis.rulesHash) }}</code>
              </div>
              <div>
                <span>差异区域</span>
                <code>{{ activeItem.basis.regions.length }} 处（{{ activeItem.basis.regions.filter((r) => r.ignored).length }} 忽略）</code>
              </div>
              <div>
                <span>依据冻结时间</span>
                <code>{{ activeItem.basis.frozenAt.slice(5, 16).replace('T', ' ') }}</code>
              </div>
            </div>

            <a-alert v-if="activeItem.validity === 'stale'" type="error" style="margin: 10px 0">
              <template #title>该页依据已失效，原结论已保留在复议项中</template>
              <div v-for="(reason, index) in activeItem.staleReasons" :key="index" class="stale-reason">
                <b>{{ reason.kind === 'screenshot' ? '截图变化' : '规则变化' }}：</b>{{ reason.detail }}
              </div>
              <a-space style="margin-top: 8px">
                <a-button
                  type="primary"
                  size="small"
                  :disabled="!held"
                  :loading="refreezeMutation.isPending.value"
                  @click="refreezeMutation.mutate()"
                >
                  按当前状态复议重冻
                </a-button>
                <a-button
                  size="small"
                  :disabled="!held"
                  :loading="recaptureMutation.isPending.value"
                  @click="recaptureMutation.mutate()"
                >
                  模拟替换当前图
                </a-button>
              </a-space>
            </a-alert>

            <div class="canvas-grid">
              <DiffCanvas :run="activeRun" side="baseline" :zoom="100" :regions="visibleRegions" />
              <DiffCanvas :run="activeRun" side="current" :zoom="100" :regions="visibleRegions" />
            </div>

            <div class="region-list batch-regions">
              <button
                v-for="region in visibleRegions"
                :key="region.id"
                class="region-item"
                :class="{ ignored: region.ignored }"
                :disabled="!held || activeItem.validity === 'stale'"
                @click="toggleIgnored(region)"
              >
                <span class="region-severity" :class="region.severity">{{ region.severity.toUpperCase() }}</span>
                <span class="region-copy">
                  <strong>
                    {{
                      region.kind === 'layout'
                        ? '布局位移'
                        : region.kind === 'color'
                          ? '色彩变化'
                          : region.kind === 'content'
                            ? '内容变更'
                            : '环境噪声'
                    }}
                  </strong>
                  <small>{{ region.x }}%, {{ region.y }}% · {{ region.pixels.toLocaleString() }} px</small>
                </span>
                <span class="ignore-action">{{ region.ignored ? '已忽略' : '忽略' }}</span>
              </button>
            </div>
          </div>

          <aside class="review-panel">
            <div class="panel-title">
              <div>
                <h3>本页结论</h3>
                <span>写入仅影响 {{ activeRun.page }}，不触碰其他页面</span>
              </div>
            </div>

            <div v-if="activeItem.review" class="review-record">
              <h4>当前结论（依据 r{{ activeItem.review.ruleRevision }}）</h4>
              <dl>
                <dt>结论</dt><dd>{{ activeItem.review.decision === 'approved' ? '已通过' : '已驳回' }}</dd>
                <dt>人员</dt><dd>{{ activeItem.review.reviewer }}</dd>
                <dt>图指纹</dt><dd>{{ shortFingerprint(activeItem.review.imageFingerprint) }}</dd>
              </dl>
              <p>{{ activeItem.review.reason }}</p>
            </div>

            <a-form :model="form" layout="vertical">
              <a-form-item label="变化类型">
                <a-select v-model="form.category" :disabled="!held || activeItem.validity === 'stale'">
                  <a-option value="design-change">设计变更</a-option>
                  <a-option value="render-error">渲染异常</a-option>
                  <a-option value="environment-noise">环境噪声</a-option>
                </a-select>
              </a-form-item>
              <a-form-item label="审批结论">
                <a-radio-group v-model="form.decision" type="button" :disabled="!held || activeItem.validity === 'stale'">
                  <a-radio value="approved">页面通过</a-radio>
                  <a-radio value="rejected">页面驳回</a-radio>
                </a-radio-group>
              </a-form-item>
              <a-form-item label="批准人">
                <a-input v-model="form.reviewer" :disabled="!held" />
              </a-form-item>
              <a-form-item label="审批原因">
                <a-textarea
                  v-model="form.reason"
                  :auto-size="{ minRows: 3, maxRows: 6 }"
                  :disabled="!held || activeItem.validity === 'stale'"
                  placeholder="说明业务需求、设计稿或异常依据"
                />
              </a-form-item>
              <a-space>
                <a-button
                  type="primary"
                  :loading="reviewMutation.isPending.value"
                  :disabled="!held || activeItem.validity === 'stale' || batch.status !== 'open'"
                  @click="submitReview"
                >
                  提交本页结论
                </a-button>
                <a-button :loading="draftMutation.isPending.value" :disabled="batch.status !== 'open'" @click="draftMutation.mutate()">
                  保存草稿
                </a-button>
              </a-space>
            </a-form>

            <div v-if="activeItem.reconsiderLog.length" class="reconsider-list">
              <a-divider />
              <h4>复议项（{{ activeItem.reconsiderLog.length }}）</h4>
              <div v-for="(entry, index) in activeItem.reconsiderLog" :key="index" class="reconsider-item">
                <small>检测于 {{ entry.detectedAt.slice(5, 16).replace('T', ' ') }}</small>
                <p v-if="entry.review">
                  原结论：{{ entry.review.decision === 'approved' ? '通过' : '驳回' }} ·
                  {{ entry.review.reviewer }} · {{ entry.review.reason }}
                </p>
                <p class="muted">
                  原依据：图 {{ shortFingerprint(entry.basis.imageFingerprint) }} · r{{ entry.basis.ruleRevision }}
                </p>
                <ul>
                  <li v-for="(reason, ri) in entry.reasons" :key="ri">{{ reason.detail }}</li>
                </ul>
              </div>
            </div>

            <div v-if="activeItem.checkpoint" class="checkpoint-box">
              <a-divider />
              <h4>恢复检查点</h4>
              <p class="muted">
                {{ activeItem.checkpoint.committed ? '基线已落库，重放将跳过本页' : '审批已落检查点，等待批次生效' }}
              </p>
              <small>{{ activeItem.checkpoint.reviewedAt.slice(5, 19).replace('T', ' ') }}</small>
            </div>
          </aside>
        </div>
      </div>

      <div v-if="batch.status === 'completed'" class="completed-panel">
        <a-result status="success" title="批次基线已生效">
          <template #subtitle>
            统一规则修订 <b>r{{ batch.committedRuleRevision }}</b>，共切换
            <b>{{ batch.promotedBaselineIds?.length ?? 0 }}</b> 条有效基线；驳回页面保留原基线。
          </template>
        </a-result>
      </div>
    </template>
  </a-spin>
</template>
