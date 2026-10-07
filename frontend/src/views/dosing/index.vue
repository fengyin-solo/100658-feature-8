<template>
  <section class="page" data-module="dosing">
    <header class="page-head">
      <div>
        <h2>混凝加药管理</h2>
        <p class="page-desc">维护混凝加药记录，围绕加药编号、加药药剂、投加浓度、加药量做登记、筛选与状态流转。投加浓度或加药量空着的加药单一律退回。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记混凝加药记录</button>
        <button class="btn" type="button" @click="exportRows">导出混凝加药清单</button>
      </div>
    </header>

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
      <span class="legend-item legend-check">
        台账/明细对账：{{ reconcile.ledgerTotal }} / {{ reconcile.detailTotal }}
        <em :class="reconcile.aligned ? 'ok-text' : 'error-text'">{{ reconcile.aligned ? '已对齐' : '不一致' }}</em>
      </span>
    </p>

    <div v-if="notice" class="notice" :class="`notice-${notice.type}`" role="alert">
      <span>{{ notice.text }}</span>
      <button v-if="notice.action" class="link" type="button" @click="notice.action()">{{ notice.actionText }}</button>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>加药编号</span>
        <input v-model="filters.加药编号" placeholder="按加药编号检索" />
      </label>
      <label class="filter-item">
        <span>加药药剂</span>
        <input v-model="filters.加药药剂" placeholder="按加药药剂检索" />
      </label>
      <label class="filter-item">
        <span>起始日期</span>
        <input v-model="filters.from" type="date" />
      </label>
      <label class="filter-item">
        <span>截止日期</span>
        <input v-model="filters.to" type="date" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div v-if="readError" class="read-error" role="alert">
      <span class="error-text">台账读取失败：{{ readError }}</span>
      <button v-if="canRetry" class="btn" type="button" :disabled="loading" @click="retryOnce">
        {{ loading ? '重试中…' : '重试一次' }}
      </button>
      <span v-else class="error-text">重试机会已用完，请联系值班长或稍后刷新页面。</span>
    </div>

    <table class="data-table dosing-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-abnormal': row.abnormal }">
          <td v-for="column in columns" :key="column" :class="{ 'cell-basis': column === '判定依据' }">
            <template v-if="column === '异常标注' && row[column]">
              <span class="tag tag-abnormal">{{ row[column] }}</span>
            </template>
            <template v-else>{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</template>
          </td>
          <td>
            <span :class="row.abnormal ? 'tag tag-abnormal' : ''">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!loading && !readError && !rows.length">
          <td :colspan="columns.length + 2" class="empty-state">
            {{ hasTimeRange ? '该时间段暂无加药登记记录（暂无数据），可先登记混凝加药记录' : '暂无混凝加药数据（暂无数据），可先登记混凝加药记录' }}
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条混凝加药记录</span>
      <span class="foot-tools">
        <button class="link" type="button" @click="simulateReadFault">演练一次读取故障</button>
      </span>
    </footer>

    <div v-if="formOpen" class="modal-mask" @click.self="closeForm">
      <form class="modal" @submit.prevent="submitForm">
        <h3>登记混凝加药记录</h3>
        <p class="modal-hint">投加浓度、加药量为必填，空着的加药单会被直接退回并写明缺项；读数支持带单位填写（如 25mg/L、1800g、86NTU），提交前按统一规则换算并判异。</p>

        <label class="form-item">
          <span>加药编号<em>*</em></span>
          <input v-model="form.加药编号" :class="{ invalid: showErrors && !form.加药编号.trim() }" />
        </label>
        <label class="form-item">
          <span>加药药剂<em>*</em></span>
          <input v-model="form.加药药剂" list="chem-options" :class="{ invalid: showErrors && !form.加药药剂.trim() }" placeholder="如 聚合氯化铝(PAC)" />
          <datalist id="chem-options">
            <option v-for="item in chemOptions" :key="item" :value="item" />
          </datalist>
        </label>
        <label class="form-item">
          <span>投加浓度<em>*</em></span>
          <input v-model="form.投加浓度" placeholder="如 25mg/L" :class="{ invalid: showErrors && !form.投加浓度.trim() }" />
          <small class="reading-preview" :class="{ 'preview-abnormal': preview.投加浓度.abnormal }">
            统一换算：{{ previewText(preview.投加浓度) }}
          </small>
        </label>
        <label class="form-item">
          <span>加药量<em>*</em></span>
          <input v-model="form.加药量" placeholder="如 48kg 或 1.2t" :class="{ invalid: showErrors && !form.加药量.trim() }" />
          <small class="reading-preview" :class="{ 'preview-abnormal': preview.加药量.abnormal }">
            统一换算：{{ previewText(preview.加药量) }}
          </small>
        </label>
        <label class="form-item">
          <span>原水浊度</span>
          <input v-model="form.原水浊度" placeholder="如 86NTU，可留空" />
          <small class="reading-preview" :class="{ 'preview-abnormal': preview.原水浊度.abnormal }">
            统一换算：{{ previewText(preview.原水浊度) }}
          </small>
        </label>
        <label class="form-item">
          <span>操作人员</span>
          <input v-model="form.操作人员" />
        </label>
        <label class="form-item">
          <span>加药时间</span>
          <input v-model="form.加药时间" type="datetime-local" />
        </label>

        <p v-if="previewAbnormal.length" class="preview-warn">
          异常读数（提交后将单独标注并写出依据，加药单挡回）：{{ previewAbnormal.join('；') }}
        </p>

        <div class="modal-actions">
          <button class="btn primary" type="submit">提交加药单</button>
          <button class="btn ghost" type="button" @click="closeForm">取消</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  armDosingReadFaultOnce,
  downloadEntries,
  listDosingEntries,
  moduleMeta,
  nextDosingNo,
  reconcileDosing,
  runAction as applyAction,
  submitDosingRecord,
} from '@/api/local-service'
import { normalizeDosingReading } from '@/data/dosing-rules'
import type { DosingListFilters, DosingSubmitInput } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('dosing')
const session = useSessionStore()
const columns = ['加药编号', '加药药剂', '投加浓度', '加药量', '原水浊度', '操作人员', '加药时间', '加药状态', '异常标注', '判定依据']
const actions = ['提交投加', '确认投加', '标记异常']
const statuses = ['待投加', '投加中', '已投加', '浓度异常']
const chemOptions = ['聚合氯化铝(PAC)', '聚合硫酸铁(PFS)', '聚丙烯酰胺(PAM)', '聚合氯化铝铁(PAFC)']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const filters = reactive<DosingListFilters>({ 加药编号: '', 加药药剂: '', from: '', to: '' })
const notice = ref<{ type: 'success' | 'warning' | 'error'; text: string; action?: () => void; actionText?: string } | null>(null)

// 读取状态：失败先提示，人工只允许重试一次；重试仍失败就不再给按钮。
const loading = ref(false)
const readError = ref('')
const canRetry = ref(false)

const hasTimeRange = computed(() => Boolean(filters.from || filters.to))
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '待投加记录', value: rows.value.filter((row) => row.pending).length },
  { label: '已投加记录', value: rows.value.filter((row) => String(row.status) === '已投加').length },
  { label: '浓度异常次数', value: rows.value.filter((row) => row.abnormal).length },
])
const reconcile = computed(() => reconcileDosing(rows.value))

function attemptLoad(): boolean {
  loading.value = true
  try {
    const payload = listDosingEntries({ ...filters })
    rows.value = payload.items
    total.value = payload.total
    readError.value = ''
    canRetry.value = false
    return true
  } catch (error) {
    rows.value = []
    total.value = 0
    readError.value = error instanceof Error ? error.message : '混凝加药列表读取失败'
    return false
  } finally {
    loading.value = false
  }
}

function reload() {
  notice.value = null
  canRetry.value = true
  attemptLoad()
}

function retryOnce() {
  if (!canRetry.value) {
    return
  }
  canRetry.value = false
  const ok = attemptLoad()
  if (ok) {
    notice.value = { type: 'success', text: '重试成功，台账统计与明细已重新对账。' }
    return
  }
  readError.value = `${readError.value}；自动重试后仍未读出，请联系值班长或稍后刷新页面。`
}

function simulateReadFault() {
  armDosingReadFaultOnce()
  reload()
}

function resetFilters() {
  filters.加药编号 = ''
  filters.加药药剂 = ''
  filters.from = ''
  filters.to = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

// ---- 登记表单 ----
const formOpen = ref(false)
const showErrors = ref(false)

function defaultTime(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

const blankForm = (): DosingSubmitInput => ({
  加药编号: nextDosingNo(),
  加药药剂: '',
  投加浓度: '',
  加药量: '',
  原水浊度: '',
  操作人员: session.operator,
  加药时间: defaultTime(),
})
const form = reactive<DosingSubmitInput>(blankForm())

const preview = computed(() => ({
  投加浓度: normalizeDosingReading('concentration', form.投加浓度),
  加药量: normalizeDosingReading('dosage', form.加药量),
  原水浊度: normalizeDosingReading('turbidity', form.原水浊度),
}))

const previewAbnormal = computed(() =>
  Object.values(preview.value)
    .filter((item) => item.abnormal)
    .map((item) => `${item.label}：${item.reason}`),
)

function previewText(item: ReturnType<typeof normalizeDosingReading>): string {
  if (item.raw === '') {
    return '未填写'
  }
  if (item.value === null) {
    return `异常——${item.reason}`
  }
  const text = `${item.value} ${item.unit}`
  return item.abnormal ? `${text}（${item.reason}）` : text
}

function openCreate() {
  Object.assign(form, blankForm())
  showErrors.value = false
  notice.value = null
  formOpen.value = true
}

function closeForm() {
  formOpen.value = false
}

function submitForm() {
  showErrors.value = true
  const missing = [!form.加药编号.trim() && '加药编号', !form.加药药剂.trim() && '加药药剂', !form.投加浓度.trim() && '投加浓度', !form.加药量.trim() && '加药量'].filter(Boolean)
  if (missing.length) {
    notice.value = { type: 'warning', text: `加药单退回：缺少${missing.join('、')}，请补全后再提交；缺项单不会入库。` }
    return
  }

  const result = submitDosingRecord({ ...form })
  if (result.decision === '通过') {
    notice.value = { type: 'success', text: result.message }
    formOpen.value = false
    reload()
    return
  }
  if (result.decision === '挡回') {
    notice.value = {
      type: 'error',
      text: result.message,
      action: () => closeForm(),
      actionText: '我知道了',
    }
    reload()
    return
  }
  // 退回与重复都不入库：表单留着，允许当场改完重报。
  notice.value = { type: result.decision === '退回' ? 'warning' : 'error', text: result.message }
}

function runAction(action: string, row: EntryRow) {
  notice.value = null
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    notice.value = { type: 'error', text: result.message }
    return
  }
  notice.value = { type: 'success', text: result.message }
  reload()
}

onMounted(reload)
</script>
