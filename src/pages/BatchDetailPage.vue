<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message, Modal } from '@arco-design/web-vue'
import {
  commitBatch,
  decideBatchPage,
  deleteBatchDraft,
  getBatch,
  getRules,
  recaptureRun,
  recoverBatch,
  saveBatchDraft,
} from '@/api/http'
import { useBatchLock } from '@/composables/useBatchLock'
import { useCrossWindowSync } from '@/composables/useCrossWindowSync'
import { rulesetRevision } from '@/utils/evidence'
import type { BatchPage, ReviewCategory, ReviewItem } from '@/types'

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const batchId = computed(() => String(route.params.id))

const { data: batch, isLoading, refetch } = useQuery({
  queryKey: computed(() => ['batch', batchId.value]),
  queryFn: () => getBatch(batchId.value),
  // 锁状态需要轮询，以便及时发现其他窗口释放
  refetchInterval: 5_000,
})

const { data: rules } = useQuery({ queryKey: ['rules'], queryFn: getRules })

useCrossWindowSync([['batches'], ['rules'], ['runs'], ['baselines']])

const { windowId, windowLabel, isHolder, holderLabel, acquiring, acquire } = useBatchLock(
  batchId,
  () => batch.value,
)

const currentRevision = computed(() => (rules.value ? rulesetRevision(rules.value) : null))

const progress = computed(() => {
  const pages = batch.value?.pages ?? []
  const done = pages.filter((page) => page.status === 'approved' || page.status === 'rejected').length
  return { done, total: pages.length }
})

const alignedRevision = computed(() => {
  const pages = batch.value?.pages ?? []
  if (pages.length === 0 || currentRevision.value === null) return false
  return pages.every((page) => page.ruleRevision === currentRevision.value && page.status !== 'invalidated')
})

const allApproved = computed(() => {
  const pages = batch.value?.pages ?? []
  return pages.length > 0 && pages.every((page) => page.status === 'approved')
})

const canCommit = computed(() => {
  if (!batch.value || batch.value.status !== 'open') return false
  if (progress.value.done !== progress.value.total) return false
  return alignedRevision.value && allApproved.value
})

const activePageId = ref<string>('')
const activePage = computed<BatchPage | undefined>(() =>
  batch.value?.pages.find((page) => page.runId === activePageId.value),
)
const pageModalVisible = computed({
  get: () => Boolean(activePage.value),
  set: (value: boolean) => {
    if (!value) activePageId.value = ''
  },
})

const form = reactive({
  category: 'design-change' as ReviewCategory,
  decision: 'approved' as 'approved' | 'rejected',
  reviewer: '林默',
  reason: '',
})

const openPage = (page: BatchPage) => {
  activePageId.value = page.runId
  if (page.decision) {
    form.category = page.decision.category
    form.decision = page.decision.decision
    form.reviewer = page.decision.reviewer
    form.reason = page.decision.reason
  } else {
    form.category = 'design-change'
    form.decision = 'approved'
    form.reason = ''
  }
}

const refreshAll = async () => {
  await queryClient.invalidateQueries({ queryKey: ['batch', batchId.value] })
  await queryClient.invalidateQueries({ queryKey: ['batches'] })
  await queryClient.invalidateQueries({ queryKey: ['runs'] })
  await queryClient.invalidateQueries({ queryKey: ['baselines'] })
  await refetch()
}

const decisionMutation = useMutation({
  mutationFn: () => {
    if (!activePage.value) throw new Error('请选择页面')
    const opId = `op-${Date.now()}-${activePage.value.runId}`
    return decideBatchPage(batchId.value, activePage.value.runId, {
      windowId,
      opId,
      ...form,
    })
  },
  onSuccess: async (result) => {
    Message.success(
      result.reAnchored
        ? '该页依据已变化：已按当前截图与规则修订重新锚定并记录复议结论'
        : '单页结论已写入，仅影响该页面（基线尚未切换）',
    )
    activePageId.value = ''
    await refreshAll()
  },
  onError: (error: Error & { status?: number }) => {
    if (error.status === 409) {
      Message.warning(`${error.message}，可将结论保存为草稿`)
    } else {
      Message.error(error.message)
    }
  },
})

const forceFail = ref(false)

const commitMutation = useMutation({
  mutationFn: () => commitBatch(batchId.value, { windowId, forceFail: forceFail.value }),
  onSuccess: async (result) => {
    forceFail.value = false
    Message.success(
      `批次已统一切换 ${result.baselines.length} 条有效基线${
        result.replayed ? `（检查点重放 ${result.replayed} 条审批，未重复新增）` : ''
      }`,
    )
    await refreshAll()
  },
  onError: (error: Error) => Message.error(error.message),
})

const recoverMutation = useMutation({
  mutationFn: () => recoverBatch(batchId.value, { windowId }),
  onSuccess: async (result) => {
    Message.success(
      `已从已通过页面检查点恢复，补写 ${result.baselines.length} 条基线，重放不重复`,
    )
    await refreshAll()
  },
  onError: (error: Error) => Message.error(error.message),
})

const saveDraftMutation = useMutation({
  mutationFn: () => {
    if (!activePage.value) throw new Error('请选择页面')
    return saveBatchDraft(batchId.value, {
      windowId,
      windowLabel,
      runId: activePage.value.runId,
      source: 'review',
      payload: { ...form },
    })
  },
  onSuccess: async () => {
    Message.success('结论已存为草稿，并标出依据已变化的页面')
    activePageId.value = ''
    await refreshAll()
  },
  onError: (error: Error) => Message.error(error.message),
})

const recaptureMutation = useMutation({
  mutationFn: (runId: string) => recaptureRun(runId),
  onSuccess: async (result) => {
    Message.info(`当前图已被替换（模拟另一窗口），${result.affected} 个批次页待复议`)
    await refreshAll()
  },
  onError: (error: Error) => Message.error(error.message),
})

const removeDraft = (draftId: string) => deleteBatchDraft(batchId.value, draftId).then(refreshAll)

const pageTag = (page: BatchPage) => {
  switch (page.status) {
    case 'approved':
      return { color: 'green', text: '已通过' }
    case 'rejected':
      return { color: 'red', text: '已驳回' }
    case 'invalidated':
      return { color: 'orange', text: '依据失效·待复议' }
    default:
      return { color: 'gray', text: '待单页结论' }
  }
}

const openReviewItems = (page: BatchPage): ReviewItem[] =>
  page.reviewItems.filter((item) => !item.resolvedAt)

const requestLock = async () => {
  await acquire()
  await refetch()
  if (isHolder.value) Message.success('已接管写入锁')
  else Message.info('写入锁仍被其他窗口持有')
}

const submitPage = () => {
  if (!form.reason.trim() || form.reason.trim().length < 8) {
    Message.warning('请填写至少 8 个字符的审批原因')
    return
  }
  decisionMutation.mutate()
}

const confirmCommit = () => {
  Modal.info({
    title: '整批切换有效基线',
    content: `全部 ${progress.value.total} 页均已给出结论并对齐到规则修订 r${currentRevision.value}，提交后才会统一启用新基线。`,
    onOk: () => commitMutation.mutate(),
  })
}
</script>

<template>
  <a-spin :loading="isLoading" style="width: 100%">
    <template v-if="batch">
      <section class="detail-heading">
        <div>
          <a-space>
            <h2>{{ batch.name }}</h2>
            <a-tag :color="batch.status === 'committed' ? 'green' : 'arcoblue'">
              {{ batch.status === 'committed' ? '已切换基线' : '审批中' }}
            </a-tag>
          </a-space>
          <p>{{ batch.id }} · {{ batch.release }} · 创建人 {{ batch.createdBy }}</p>
        </div>
        <a-space>
          <a-button @click="router.push('/approvals')"><icon-left /> 返回队列</a-button>
          <a-button
            v-if="batch.status === 'open' && !isHolder"
            type="primary"
            :loading="acquiring"
            @click="requestLock"
          >
            申请接管写入
          </a-button>
          <a-button
            v-if="batch.status === 'open'"
            type="primary"
            status="success"
            :disabled="!canCommit || !isHolder"
            :loading="commitMutation.isPending.value"
            @click="confirmCommit"
          >
            <icon-check-circle /> 整批提交并切换基线
          </a-button>
        </a-space>
      </section>

      <a-alert v-if="!isHolder" type="warning" style="margin-bottom: 14px">
        当前写入锁由 <b>{{ holderLabel }}</b> 持有，本窗口为只读，单页结论可保存为草稿；锁释放后可申请接管。
      </a-alert>
      <a-alert
        v-else-if="batch.status === 'open' && batch.pages.some((p) => p.status === 'rejected')"
        type="warning"
        style="margin-bottom: 14px"
      >
        存在已驳回页面：整批只在“全部页面批准且依据同一修订”时切换基线，驳回页需改判为批准或撤出批次。
      </a-alert>
      <a-alert v-else-if="batch.status === 'open'" type="success" style="margin-bottom: 14px">
        本窗口（{{ windowLabel }}）持有写入锁，其他窗口只能保存草稿。
      </a-alert>

      <div class="run-facts batch-facts">
        <div>
          <span>单页进度</span>
          <strong>{{ progress.done }} / {{ progress.total }} 已结论</strong>
        </div>
        <div>
          <span>建批次规则修订</span>
          <strong>r{{ batch.ruleRevision }}</strong>
        </div>
        <div>
          <span>当前规则修订</span>
          <strong :class="{ mismatch: !alignedRevision }">
            r{{ currentRevision }}
            <a-tag v-if="!alignedRevision" color="red" size="small">未对齐</a-tag>
          </strong>
        </div>
        <div>
          <span>提交条件</span>
          <strong>
            {{ canCommit ? '全部通过且依据统一，可提交' : '需全部批准、无待复议且修订一致' }}
          </strong>
        </div>
      </div>

      <a-alert
        v-if="batch.checkpoint?.failedAt"
        type="error"
        style="margin-bottom: 14px"
      >
        <template #title>检测到写入中断的检查点</template>
        已保留 {{ batch.checkpoint.completedRunIds.length }} 个已通过页面的依据，
        {{ batch.checkpoint.failReason }}。恢复时按幂等键重放，不重复新增审批或基线。
        <template #extra>
          <a-button
            size="small"
            type="primary"
            status="danger"
            :disabled="!isHolder"
            :loading="recoverMutation.isPending.value"
            @click="recoverMutation.mutate()"
          >
            从检查点恢复
          </a-button>
        </template>
      </a-alert>

      <a-card class="table-panel" :bordered="false">
        <template #title>批次页面与批准依据</template>
        <template #extra>
          <span class="muted">每页记录当前图指纹、命中规则修订与差异区域快照</span>
        </template>
        <a-table :data="batch.pages" :pagination="false" row-key="runId">
          <template #columns>
            <a-table-column title="页面" :width="200">
              <template #cell="{ record }">
                <div class="primary-cell">
                  <strong>{{ record.page }}</strong>
                  <span>{{ record.runId }} · {{ record.device }}</span>
                </div>
              </template>
            </a-table-column>
            <a-table-column title="当前图指纹" :width="180">
              <template #cell="{ record }">
                <code>{{ record.imageFingerprint.slice(0, 18) }}…</code>
              </template>
            </a-table-column>
            <a-table-column title="命中规则修订" :width="150">
              <template #cell="{ record }">
                <a-space direction="vertical" :size="2">
                  <span>修订 r{{ record.ruleRevision }}</span>
                  <span class="muted">{{ record.matchedRules.length }} 条规则命中</span>
                </a-space>
              </template>
            </a-table-column>
            <a-table-column title="差异区域快照" :width="160">
              <template #cell="{ record }">
                <code>{{ record.regionFingerprint }}</code>
              </template>
            </a-table-column>
            <a-table-column title="状态 / 复议项" :width="240">
              <template #cell="{ record }">
                <a-space direction="vertical" :size="4">
                  <a-tag :color="pageTag(record).color">{{ pageTag(record).text }}</a-tag>
                  <div v-for="item in openReviewItems(record)" :key="item.id">
                    <a-tag size="small" :color="item.kind === 'screenshot' ? 'red' : 'orange'">
                      {{ item.kind === 'screenshot' ? '截图变化' : '规则修订变化' }}
                    </a-tag>
                    <span class="muted">待复议</span>
                  </div>
                </a-space>
              </template>
            </a-table-column>
            <a-table-column title="操作" :width="210">
              <template #cell="{ record }">
                <a-space :size="4" wrap>
                  <a-button
                    size="mini"
                    type="outline"
                    :disabled="!isHolder || batch.status !== 'open'"
                    @click="openPage(record)"
                  >
                    {{ record.status === 'invalidated' ? '复议并结论' : '单页结论' }}
                  </a-button>
                  <a-button
                    size="mini"
                    status="warning"
                    @click="recaptureMutation.mutate(record.runId)"
                  >
                    模拟换图
                  </a-button>
                  <router-link :to="`/runs/${record.runId}`">查看差异</router-link>
                </a-space>
              </template>
            </a-table-column>
          </template>
        </a-table>
      </a-card>

      <div class="baseline-layout" style="margin-top: 16px">
        <a-card class="table-panel" :bordered="false">
          <template #title>切换说明</template>
          <ul class="basis-list">
            <li>建批次时冻结每页当前图指纹、差异区域快照与命中规则修订，构成同一条批准依据。</li>
            <li>单页结论只改对应页面，不会提前创建基线。</li>
            <li>规则修订或截图一旦变化，受影响页立即转为“待复议”；已完成页保留原结论并列入复议项。</li>
            <li>所有页面完成复议且对齐同一规则修订后，“整批提交”才会统一切换有效基线。</li>
            <li>
              演示写入失败：
              <a-switch v-model="forceFail" size="small" style="margin: 0 6px" />
              下次提交时在基线写入中途失败，随后可从检查点幂等恢复。
            </li>
          </ul>
          <div v-if="batch.status === 'committed'" class="committed-box">
            <a-tag color="green">已提交</a-tag>
            生效基线 {{ batch.baselineIds?.length ?? 0 }} 条 ·
            提交时间 {{ batch.committedAt?.slice(0, 16).replace('T', ' ') }}
          </div>
        </a-card>

        <aside class="history-panel draft-panel">
          <div class="panel-title">
            <div>
              <h3>其他窗口草稿</h3>
              <span>未抢到写入锁时的结论留痕</span>
            </div>
          </div>
          <a-empty v-if="batch.drafts.length === 0" description="暂无草稿" style="margin-top: 20px" />
          <div v-for="draft in batch.drafts" :key="draft.id" class="draft-item">
            <div class="draft-head">
              <strong>{{ draft.windowLabel }}</strong>
              <a-button size="mini" type="text" status="danger" @click="removeDraft(draft.id)">
                <icon-delete />
              </a-button>
            </div>
            <p>{{ draft.payload?.reason ?? '差异区域忽略调整' }}</p>
            <div class="draft-meta">
              <a-tag size="small" :color="draft.payload?.decision === 'rejected' ? 'red' : 'green'">
                {{ draft.payload?.decision === 'rejected' ? '驳回草稿' : '批准草稿' }}
              </a-tag>
              <span>{{ draft.savedAt.slice(5, 16).replace('T', ' ') }}</span>
            </div>
            <div v-if="draft.changedPages.length" class="draft-changed">
              <icon-exclamation-circle-fill /> 保存时已有 {{ draft.changedPages.length }} 个页面依据变化
            </div>
          </div>
        </aside>
      </div>

      <a-modal
        v-model:visible="pageModalVisible"
        :title="`单页结论 · ${activePage?.page ?? ''}`"
        :ok-loading="decisionMutation.isPending.value"
        :mask-closable="false"
        :ok-text="isHolder ? '写入该页结论' : '保存为草稿'"
        :cancel-text="isHolder ? '关闭' : '关闭'"
        @ok="isHolder ? submitPage() : saveDraftMutation.mutate()"
        @cancel="activePageId = ''"
        @close="activePageId = ''"
      >
        <div v-if="activePage">
          <a-alert v-if="activePage.status === 'invalidated'" type="warning" style="margin-bottom: 14px">
            <template #title>该页依据已失效，需重新复议</template>
            <div v-for="item in openReviewItems(activePage)" :key="item.id">
              <p style="margin: 4px 0">{{ item.detail }}</p>
              <div v-if="item.previousDecision" class="previous-decision">
                原结论（已保留）：{{ item.previousDecision.decision === 'approved' ? '批准' : '驳回' }} ·
                {{ item.previousDecision.reviewer }} · {{ item.previousDecision.reason }}
              </div>
            </div>
          </a-alert>
          <div class="basis-snapshot">
            <div><span>图指纹</span><code>{{ activePage.imageFingerprint.slice(0, 22) }}…</code></div>
            <div><span>区域快照</span><code>{{ activePage.regionFingerprint }}</code></div>
            <div><span>规则修订</span><code>r{{ activePage.ruleRevision }}</code></div>
          </div>
          <a-form :model="form" layout="vertical" style="margin-top: 8px">
            <a-form-item label="变化类型" required>
              <a-select v-model="form.category">
                <a-option value="design-change">设计变更</a-option>
                <a-option value="render-error">渲染异常</a-option>
                <a-option value="environment-noise">环境噪声</a-option>
              </a-select>
            </a-form-item>
            <a-form-item label="审批结论" required>
              <a-radio-group v-model="form.decision" type="button">
                <a-radio value="approved">批准该页</a-radio>
                <a-radio value="rejected">驳回该页</a-radio>
              </a-radio-group>
            </a-form-item>
            <a-form-item label="结论人" required>
              <a-input v-model="form.reviewer" />
            </a-form-item>
            <a-form-item label="审批原因（至少 8 个字符）" required>
              <a-textarea v-model="form.reason" :auto-size="{ minRows: 3, maxRows: 6 }" />
            </a-form-item>
          </a-form>
          <a-alert v-if="!isHolder" type="info">
            本窗口不持有写入锁，确认后将作为草稿保存给持锁窗口，并标出已变化页面。
          </a-alert>
        </div>
      </a-modal>
    </template>
  </a-spin>
</template>
