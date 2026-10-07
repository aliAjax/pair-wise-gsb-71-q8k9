<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message, Modal } from '@arco-design/web-vue'
import { abandonBatch, createBatch, getProjects, getRuns, getBatches } from '@/api/http'
import { lockPayload, windowLabel } from '@/utils/windowSession'
import type { ApprovalBatch } from '@/types'

const router = useRouter()
const queryClient = useQueryClient()
const modalVisible = ref(false)
const batchName = ref('')
const selectedRunIds = ref<string[]>([])
const projectFilter = ref('')

const { data: batches, isLoading } = useQuery({
  queryKey: ['batches'],
  queryFn: getBatches,
  refetchInterval: 4000,
})
const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: getProjects })
const { data: pendingRuns } = useQuery({
  queryKey: ['runs', { status: 'pending' }],
  queryFn: () => getRuns({ status: 'pending' }),
})

const candidateRuns = computed(() =>
  (pendingRuns.value ?? []).filter((run) => !projectFilter.value || run.projectId === projectFilter.value),
)

const projectName = (id: string) =>
  projects.value?.find((project) => project.id === id)?.name ?? id

const createMutation = useMutation({
  mutationFn: () =>
    createBatch({
      name: batchName.value.trim(),
      runIds: selectedRunIds.value,
      createdBy: '林默',
      ...lockPayload(),
    }),
  onSuccess: async (detail) => {
    Message.success(`批次已创建，已冻结 ${detail.batch.items.length} 个页面的图指纹与规则修订`)
    modalVisible.value = false
    batchName.value = ''
    selectedRunIds.value = []
    await queryClient.invalidateQueries({ queryKey: ['batches'] })
    await router.push(`/batches/${detail.batch.id}`)
  },
  onError: (error: Error) => Message.error(error.message),
})

const submitCreate = () => {
  if (!batchName.value.trim()) {
    Message.warning('请填写批次名称')
    return
  }
  if (selectedRunIds.value.length < 2) {
    Message.warning('批次至少选择 2 个页面，逐页结论将只影响对应页面')
    return
  }
  createMutation.mutate()
}

const confirmAbandon = (batch: ApprovalBatch) => {
  Modal.warning({
    title: '放弃批次',
    content: `放弃「${batch.name}」后各页恢复独立审批，已通过页面不会产生基线。`,
    hideCancel: false,
    onOk: async () => {
      await abandonBatch(batch.id)
      Message.success('批次已放弃')
      await queryClient.invalidateQueries({ queryKey: ['batches'] })
    },
  })
}

const batchStatusTag = (batch: ApprovalBatch) => {
  const map = {
    open: { color: 'arcoblue', label: '审批中' },
    committing: { color: 'orange', label: '生效中' },
    completed: { color: 'green', label: '已生效' },
    abandoned: { color: 'gray', label: '已放弃' },
  } as const
  return map[batch.status]
}

const staleCount = (batch: ApprovalBatch) => batch.items.filter((item) => item.validity === 'stale').length
const decidedCount = (batch: ApprovalBatch) =>
  batch.items.filter((item) => item.status === 'approved' || item.status === 'rejected').length

const lockSummary = (batch: ApprovalBatch) =>
  batch.lock ? `${batch.lock.windowLabel} 编辑中` : '空闲'
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>发布基线批准批次</h2>
      <p>
        建批次时冻结每页当前图指纹与命中规则修订；规则或截图一变，受影响页立即失效待审。
        全部页面通过且依据同一修订后，批次才一次性切换有效基线。
      </p>
    </div>
    <a-button type="primary" @click="modalVisible = true">
      <icon-plus /> 新建批准批次
    </a-button>
  </section>

  <a-alert type="info" style="margin-bottom: 16px">
    当前身份：<b>{{ windowLabel }}</b>。同一时刻只有一个窗口可以写入批次；其他窗口可保存草稿，系统会标出已变化页面。
  </a-alert>

  <a-card class="table-panel" :bordered="false">
    <a-table :data="batches" :loading="isLoading" :pagination="false" row-key="id">
      <template #columns>
        <a-table-column title="批次" :width="240">
          <template #cell="{ record }">
            <div class="primary-cell">
              <router-link :to="`/batches/${record.id}`"><strong>{{ record.name }}</strong></router-link>
              <span>{{ record.id }} · {{ record.createdAt.slice(5, 16).replace('T', ' ') }}</span>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="状态" :width="110">
          <template #cell="{ record }">
            <a-tag :color="batchStatusTag(record).color">{{ batchStatusTag(record).label }}</a-tag>
          </template>
        </a-table-column>
        <a-table-column title="逐页结论" :width="150">
          <template #cell="{ record }">
            {{ decidedCount(record) }} / {{ record.items.length }} 页
            <a-tag v-if="staleCount(record) > 0" color="red" size="small">{{ staleCount(record) }} 页失效</a-tag>
          </template>
        </a-table-column>
        <a-table-column title="统一规则修订" :width="130">
          <template #cell="{ record }">
            <a-tag :color="record.committedRuleRevision ? 'green' : 'arcoblue'">
              r{{ record.committedRuleRevision ?? record.ruleRevision }}
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column title="写入窗口" :width="140">
          <template #cell="{ record }">
            <span :class="{ 'lock-active': Boolean(record.lock) }">
              <icon-lock v-if="record.lock" /> {{ lockSummary(record) }}
            </span>
          </template>
        </a-table-column>
        <a-table-column title="生效基线" :width="220">
          <template #cell="{ record }">
            <span v-if="record.promotedBaselineIds?.length" class="muted">
              {{ record.promotedBaselineIds.length }} 条基线已切换
            </span>
            <span v-else-if="record.failureNote" class="danger">生效失败，待恢复</span>
            <span v-else class="muted">全部通过后统一切换</span>
          </template>
        </a-table-column>
        <a-table-column title="操作" :width="150" fixed="right">
          <template #cell="{ record }">
            <a-space :size="4">
              <router-link :to="`/batches/${record.id}`">进入评审</router-link>
              <a-button
                v-if="record.status === 'open'"
                type="text"
                status="danger"
                size="mini"
                @click="confirmAbandon(record)"
              >
                放弃
              </a-button>
            </a-space>
          </template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>

  <a-modal
    v-model:visible="modalVisible"
    title="新建批准批次"
    :ok-loading="createMutation.isPending.value"
    ok-text="冻结依据并建批次"
    width="760px"
    @ok="submitCreate"
  >
    <a-form :model="{ batchName }" layout="vertical">
      <a-form-item label="批次名称" required>
        <a-input v-model="batchName" placeholder="例如：release/6.18.0 全页面基线批准" />
      </a-form-item>
      <a-form-item :label="`选择页面（已选 ${selectedRunIds.length} 个，至少 2 个）`" required>
        <a-space style="margin-bottom: 8px">
          <a-select v-model="projectFilter" allow-clear placeholder="全部项目" style="width: 220px">
            <a-option v-for="project in projects" :key="project.id" :value="project.id">
              {{ project.name }}
            </a-option>
          </a-select>
          <span class="muted">仅可选择待审批运行；已在其他开放批次中的页面会被跳过</span>
        </a-space>
        <a-table
          v-model:selectedKeys="selectedRunIds"
          :data="candidateRuns"
          :pagination="{ pageSize: 6 }"
          row-key="id"
          :row-selection="{ type: 'checkbox', showCheckedAll: true }"
          :scroll="{ y: 260 }"
        >
          <template #columns>
            <a-table-column title="页面" data-index="page" :width="150" />
            <a-table-column title="项目" :width="160">
              <template #cell="{ record }">{{ projectName(record.projectId) }}</template>
            </a-table-column>
            <a-table-column title="设备" data-index="device" :width="150" />
            <a-table-column title="差异率" :width="90">
              <template #cell="{ record }">{{ record.mismatchRate.toFixed(2) }}%</template>
            </a-table-column>
            <a-table-column title="当前版本" :width="140">
              <template #cell="{ record }"><code>{{ record.currentVersion }}</code></template>
            </a-table-column>
          </template>
        </a-table>
      </a-form-item>
    </a-form>
  </a-modal>
</template>
