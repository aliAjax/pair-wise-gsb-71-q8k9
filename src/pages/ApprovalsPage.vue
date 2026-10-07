<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Message } from '@arco-design/web-vue'
import { createBatch, getBatches, getProjects, getRuns, mergeRuns } from '@/api/http'
import StatusTag from '@/components/StatusTag.vue'
import { useCrossWindowSync } from '@/composables/useCrossWindowSync'
import type { ScreenshotRun } from '@/types'

const queryClient = useQueryClient()
const router = useRouter()
const selectedKeys = ref<string[]>([])
const createVisible = ref(false)

const { data: runs, isLoading } = useQuery({
  queryKey: ['runs', { status: 'pending' }],
  queryFn: () => getRuns({ status: 'pending' }),
})

const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: getProjects })
const { data: batches } = useQuery({
  queryKey: ['batches', 'open'],
  queryFn: () => getBatches('open'),
  refetchInterval: 5_000,
})

useCrossWindowSync([['batches'], ['runs']])

const batchForm = reactive({
  name: '',
  projectId: 'p-commerce',
  release: 'release/6.18.0',
  runIds: [] as string[],
})

const candidateRuns = computed(() =>
  (runs.value ?? []).filter((run) => run.projectId === batchForm.projectId),
)

const mergeMutation = useMutation({
  mutationFn: mergeRuns,
  onSuccess: async () => {
    Message.success('重复运行已合并，并保留每次执行来源')
    selectedKeys.value = []
    await queryClient.invalidateQueries({ queryKey: ['runs'] })
  },
  onError: (error: Error) => Message.error(error.message),
})

const createBatchMutation = useMutation({
  mutationFn: () =>
    createBatch({
      name: batchForm.name,
      projectId: batchForm.projectId,
      release: batchForm.release,
      runIds: batchForm.runIds,
      createdBy: '林默',
    }),
  onSuccess: async (batch) => {
    Message.success('批次已创建：每页当前图指纹与命中规则修订已冻结为批准依据')
    createVisible.value = false
    batchForm.name = ''
    batchForm.runIds = []
    await queryClient.invalidateQueries({ queryKey: ['batches'] })
    await router.push(`/approvals/batches/${batch.id}`)
  },
  onError: (error: Error) => Message.error(error.message),
})

const submitCreateBatch = () => {
  if (batchForm.runIds.length < 2) {
    Message.warning('批次至少选择 2 个页面，才能按同一修订整批批准')
    return
  }
  if (!batchForm.release.trim()) {
    Message.warning('请填写发布/构建版本')
    return
  }
  createBatchMutation.mutate()
}

const unignoredCount = (run: ScreenshotRun) =>
  run.regions.filter((region) => !region.ignored).length

const projectName = (id: string) =>
  projects.value?.find((project) => project.id === id)?.name ?? id

const batchProgress = (pageCount: number, pages: { status: string }[]) => {
  const done = pages.filter((page) => page.status === 'approved' || page.status === 'rejected').length
  const invalidated = pages.filter((page) => page.status === 'invalidated').length
  return { done, pageCount, invalidated }
}
</script>

<template>
  <section class="page-intro compact">
    <div>
      <h2>待审批队列</h2>
      <p>发布经理按批次冻结批准依据：每页单签结论，规则或截图变化立即失效复议，整批依据统一后才切换基线。</p>
    </div>
    <a-space>
      <a-button type="primary" @click="createVisible = true"><icon-storage /> 新建审批批次</a-button>
      <a-button :disabled="selectedKeys.length < 2" @click="mergeMutation.mutate(selectedKeys)">
        <icon-merge /> 合并重复运行
      </a-button>
    </a-space>
  </section>

  <a-card v-if="batches && batches.length > 0" class="table-panel batch-overview" :bordered="false">
    <template #title>审批批次（批准依据链）</template>
    <template #extra><span class="muted">状态变化由其他窗口实时同步</span></template>
    <div class="batch-cards">
      <router-link
        v-for="batch in batches"
        :key="batch.id"
        :to="`/approvals/batches/${batch.id}`"
        class="batch-card"
      >
        <div class="batch-card-head">
          <strong>{{ batch.name }}</strong>
          <a-tag size="small" :color="batch.lock ? 'red' : 'green'">
            {{ batch.lock ? `${batch.lock.windowLabel} 写入中` : '可写入' }}
          </a-tag>
        </div>
        <p>{{ projectName(batch.projectId) }} · {{ batch.release }} · r{{ batch.ruleRevision }}</p>
        <div class="batch-progress">
          <a-progress
            :percent="Math.round((batchProgress(batch.pages.length, batch.pages).done / batch.pages.length) * 100)"
            size="small"
          />
          <span>
            {{ batchProgress(batch.pages.length, batch.pages).done }}/{{ batch.pages.length }} 已结论
            <template v-if="batchProgress(batch.pages.length, batch.pages).invalidated">
              · <b class="danger">{{ batchProgress(batch.pages.length, batch.pages).invalidated }} 待复议</b>
            </template>
          </span>
        </div>
        <div v-if="batch.checkpoint?.failedAt" class="batch-checkpoint">
          <icon-exclamation-circle-fill /> 写入中断，可从检查点恢复
        </div>
      </router-link>
    </div>
  </a-card>

  <div class="queue-summary">
    <div>
      <span>当前待审批</span>
      <strong>{{ runs?.length ?? 0 }}</strong>
    </div>
    <div>
      <span>高风险运行</span>
      <strong class="danger">{{ runs?.filter((run) => run.mismatchRate >= 5).length ?? 0 }}</strong>
    </div>
    <div>
      <span>进行中批次</span>
      <strong>{{ batches?.length ?? 0 }}</strong>
    </div>
    <div>
      <span>批次待复议页</span>
      <strong class="danger">
        {{ batches?.reduce((sum, batch) => sum + batch.pages.filter((p) => p.status === 'invalidated').length, 0) ?? 0 }}
      </strong>
    </div>
  </div>

  <a-card class="table-panel" :bordered="false">
    <a-table
      v-model:selected-keys="selectedKeys"
      :data="runs"
      :loading="isLoading"
      :pagination="false"
      row-key="id"
      :row-selection="{ type: 'checkbox', showCheckedAll: true }"
    >
      <template #columns>
        <a-table-column title="优先队列" :width="260">
          <template #cell="{ record }">
            <div class="primary-cell">
              <router-link :to="`/runs/${record.id}`">{{ record.page }}</router-link>
              <span>{{ record.name }} · {{ record.id }}</span>
            </div>
          </template>
        </a-table-column>
        <a-table-column title="风险" :width="130">
          <template #cell="{ record }">
            <a-tag :color="record.mismatchRate >= 5 ? 'red' : record.mismatchRate >= 2 ? 'orange' : 'gray'">
              {{ record.mismatchRate.toFixed(2) }}%
            </a-tag>
          </template>
        </a-table-column>
        <a-table-column title="差异区域" :width="150">
          <template #cell="{ record }">{{ unignoredCount(record) }} 处待判定</template>
        </a-table-column>
        <a-table-column title="构建" data-index="build" :width="180" />
        <a-table-column title="提交时间" :width="150">
          <template #cell="{ record }">{{ record.capturedAt.slice(5, 16).replace('T', ' ') }}</template>
        </a-table-column>
        <a-table-column title="状态" :width="100">
          <template #cell="{ record }"><StatusTag :status="record.status" /></template>
        </a-table-column>
        <a-table-column title="操作" :width="100" fixed="right">
          <template #cell="{ record }"><router-link :to="`/runs/${record.id}`">开始评审</router-link></template>
        </a-table-column>
      </template>
    </a-table>
  </a-card>

  <a-modal
    v-model:visible="createVisible"
    title="新建审批批次（冻结批准依据）"
    :ok-loading="createBatchMutation.isPending.value"
    ok-text="创建批次"
    width="680px"
    @ok="submitCreateBatch"
  >
    <a-form :model="batchForm" layout="vertical">
      <a-grid :cols="2" :col-gap="16">
        <a-grid-item>
          <a-form-item label="发布版本" required>
            <a-input v-model="batchForm.release" placeholder="release/6.18.0" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="所属项目" required>
            <a-select v-model="batchForm.projectId">
              <a-option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</a-option>
            </a-select>
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="批次名称">
        <a-input v-model="batchForm.name" :placeholder="`${batchForm.release} 整批基线审批`" />
      </a-form-item>
      <a-form-item :label="`纳入批次的页面（至少 2 个，已选 ${batchForm.runIds.length}）`" required>
        <a-checkbox-group v-model="batchForm.runIds" direction="vertical" class="batch-pick-list">
          <a-checkbox
            v-for="run in candidateRuns"
            :key="run.id"
            :value="run.id"
            :disabled="batchForm.runIds.length >= 8 && !batchForm.runIds.includes(run.id)"
          >
            {{ run.page }} · {{ run.device }} · {{ run.mismatchRate.toFixed(2) }}% · {{ run.id }}
          </a-checkbox>
        </a-checkbox-group>
        <div v-if="candidateRuns.length === 0" class="muted">该项目暂无待审批运行，可先在“回归运行”上传截图。</div>
      </a-form-item>
    </a-form>
    <a-alert type="info">
      创建后系统会为每页冻结当前图指纹、差异区域快照和命中规则修订；任一项变化，对应页面立即待复议。
    </a-alert>
  </a-modal>
</template>
