<template>
  <section class="page" data-module="dosing">
    <header class="page-head">
      <div>
        <h2>混凝加药管理</h2>
        <p class="page-desc">按统一口径登记投加浓度、加药量和原水浊度；缺项退回，重复编号只记一次。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showForm = !showForm">
          {{ showForm ? '收起录入单' : '登记混凝加药记录' }}
        </button>
        <button class="btn" type="button" @click="exportRows">导出混凝加药台账</button>
      </div>
    </header>

    <form v-if="showForm" class="entry-panel" @submit.prevent="submitRecord">
      <div class="form-grid">
        <label>
          <span>加药编号</span>
          <input v-model="form.加药编号" placeholder="如 DOSI-0004" />
        </label>
        <label>
          <span>加药药剂</span>
          <input v-model="form.加药药剂" placeholder="如 聚合氯化铝" />
        </label>
        <label>
          <span>投加浓度</span>
          <input v-model="form.投加浓度" placeholder="如 28 mg/L，或 0.0028%" />
        </label>
        <label>
          <span>加药量</span>
          <input v-model="form.加药量" placeholder="如 42 kg" />
        </label>
        <label>
          <span>原水浊度</span>
          <input v-model="form.原水浊度" placeholder="如 180 NTU" />
        </label>
        <label>
          <span>操作人员</span>
          <input v-model="form.操作人员" placeholder="值班人员姓名" />
        </label>
        <label>
          <span>加药时间</span>
          <input v-model="form.加药时间" placeholder="YYYY-MM-DD HH:mm" />
        </label>
      </div>
      <div class="form-actions">
        <button class="btn primary" type="submit">报送入库</button>
        <button class="btn ghost" type="button" @click="resetForm">清空</button>
        <span v-if="submitMessage" :class="submitOk ? 'success-text' : 'error-text'">
          {{ submitMessage }}
        </span>
      </div>
    </form>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item">
        <span>开始日期</span>
        <input v-model="startDate" type="date" />
      </label>
      <label class="filter-item">
        <span>结束日期</span>
        <input v-model="endDate" type="date" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div v-if="loading" class="state-banner">正在读取混凝加药台账…</div>
    <div v-else-if="readError" class="state-banner error-banner">
      <span>{{ readError }}</span>
      <button v-if="canRetry" class="btn" type="button" @click="retryLoad">重试一次</button>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <span v-if="column === '异常标注' && row[column]" class="abnormal-tag">
              {{ row[column] }}
            </span>
            <span v-else-if="column === '判定依据'" class="basis-text">{{ row[column] }}</span>
            <span v-else>{{ row[column] || '—' }}</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runRowAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!loading && !readError && !rows.length">
          <td :colspan="columns.length + 2" class="empty-state">
            暂无数据：所选时间段内没有混凝加药记录
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>台账总数与明细行数均为 {{ total }}，数字来自同一次读取结果</span>
      <span v-if="actionMessage" class="error-text">{{ actionMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  exportDosingEntries,
  queryDosingRecords,
  runDosingAction,
  submitDosingRecord,
  type AssessedDosingRow,
} from '@/api/dosing-service'
import type { DosingForm } from '@/data/types'

const columns = [
  '加药编号',
  '加药药剂',
  '投加浓度',
  '加药量',
  '原水浊度',
  '标准浊度',
  '标准浓度',
  '操作人员',
  '加药时间',
  '异常标注',
  '判定依据',
]
const actions = ['提交投加', '确认投加', '判定批复', '标记异常']
const statuses = ['待投加', '投加中', '已投加', '已批复', '浓度异常']
const filterFields = ['加药编号', '加药药剂', '投加浓度']

function emptyForm(): DosingForm {
  return {
    加药编号: '',
    加药药剂: '',
    投加浓度: '',
    加药量: '',
    原水浊度: '',
    操作人员: '',
    加药时间: '',
  }
}

const rows = ref<AssessedDosingRow[]>([])
const total = ref(0)
const loading = ref(false)
const readError = ref('')
const canRetry = ref(false)
const actionMessage = ref('')
const submitMessage = ref('')
const submitOk = ref(false)
const showForm = ref(false)
const form = ref<DosingForm>(emptyForm())
const filters = ref<Record<string, string>>({})
const startDate = ref('')
const endDate = ref('')

const stats = computed(() => [
  { label: '待处理记录', value: rows.value.filter((row) => row.pending).length },
  { label: '已批复记录', value: rows.value.filter((row) => row.status === '已批复').length },
  { label: '异常读数次数', value: rows.value.filter((row) => row.abnormal).length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

async function loadRows() {
  loading.value = true
  readError.value = ''
  try {
    const payload = await queryDosingRecords({
      filters: filters.value,
      startDate: startDate.value,
      endDate: endDate.value,
    })
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    rows.value = []
    total.value = 0
    readError.value = error instanceof Error ? error.message : '混凝加药台账读取失败'
  } finally {
    loading.value = false
  }
}

async function reload() {
  canRetry.value = true
  actionMessage.value = ''
  await loadRows()
}

async function retryLoad() {
  if (!canRetry.value) {
    return
  }
  canRetry.value = false
  await loadRows()
}

function resetFilters() {
  filters.value = {}
  startDate.value = ''
  endDate.value = ''
  void reload()
}

function resetForm() {
  form.value = emptyForm()
  submitMessage.value = ''
}

async function submitRecord() {
  submitOk.value = false
  const result = submitDosingRecord({ ...form.value })
  submitMessage.value = result.message
  submitOk.value = result.ok
  if (result.ok) {
    resetForm()
    await reload()
  }
}

async function runRowAction(action: string, row: AssessedDosingRow) {
  actionMessage.value = ''
  const result = runDosingAction(Number(row.id), action)
  if (!result.ok) {
    actionMessage.value = result.message
    return
  }
  actionMessage.value = result.message
  await reload()
}

function exportRows() {
  const { filename, content } = exportDosingEntries()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

onMounted(reload)
</script>
