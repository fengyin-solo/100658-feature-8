import { filterRows, runAction } from '@/api/local-service'
import { listRows, saveRows } from '@/data/local-store'
import {
  normalizeConcentration,
  normalizeTurbidity,
  parsePositiveAmount,
  recommendConcentration,
} from '@/data/measurement'
import type {
  ActionResult,
  DosingForm,
  DosingQuery,
  EntryRow,
  PageResult,
} from '@/data/types'

const DOSING_KEY = 'dosing'
const SHIFT_KEY = 'shift'
const MAINTENANCE_KEY = 'equipmaint'
const READ_TIMEOUT_MS = 3000

const REQUIRED_FIELDS: Array<{ key: keyof DosingForm; label: string }> = [
  { key: '加药编号', label: '加药编号' },
  { key: '加药药剂', label: '加药药剂' },
  { key: '投加浓度', label: '投加浓度' },
  { key: '加药量', label: '加药量' },
  { key: '原水浊度', label: '原水浊度' },
  { key: '操作人员', label: '操作人员' },
  { key: '加药时间', label: '加药时间' },
]

export type AssessedDosingRow = EntryRow & {
  标准浊度: string
  标准浓度: string
  异常标注: string
  判定依据: string
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function moduleCode(prefix: string, id: number): string {
  return `${prefix}-${String(id).padStart(4, '0')}`
}

function inPeriod(row: EntryRow, startDate?: string, endDate?: string): boolean {
  const day = String(row['加药时间'] ?? '').slice(0, 10)
  if (startDate && (day < startDate || day === '')) {
    return false
  }
  if (endDate && day > endDate) {
    return false
  }
  return true
}

function assessRow(row: EntryRow): AssessedDosingRow {
  const turbidity = normalizeTurbidity(String(row['原水浊度'] ?? ''))
  const concentration = normalizeConcentration(String(row['投加浓度'] ?? ''))
  const recommendation = recommendConcentration(turbidity)
  const reasons = [turbidity.reason, concentration.reason].filter(Boolean)
  const measurementAbnormal = turbidity.abnormal || concentration.abnormal
  const abnormal = Boolean(row.abnormal) || measurementAbnormal
  const manualAnnotation = String(row['异常标注'] ?? '')
  const annotation = manualAnnotation || reasons.join('；')
  const basis =
    String(row['判定依据'] ?? '') ||
    `原水浊度：${turbidity.basis}；投加浓度：${concentration.basis}；参考依据：${recommendation.basis}`

  return {
    ...row,
    abnormal,
    pending: row.status !== '已批复',
    标准浊度: turbidity.valid ? `${turbidity.value} ${turbidity.unit}` : '—',
    标准浓度: concentration.valid ? `${concentration.value} ${concentration.unit}` : '—',
    异常标注: annotation,
    判定依据: basis,
  }
}

function assessRows(rows: EntryRow[]): AssessedDosingRow[] {
  return rows.map(assessRow)
}

function readWithTimeout<T>(reader: () => T, timeoutMessage: string): Promise<T> {
  let timer: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(timeoutMessage)), READ_TIMEOUT_MS)
  })
  const reading = new Promise<T>((resolve, reject) => {
    try {
      resolve(reader())
    } catch (error) {
      reject(error)
    }
  })
  return Promise.race([reading, timeout]).finally(() => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
    }
  })
}

export async function queryDosingRecords(query: DosingQuery = {}): Promise<PageResult<AssessedDosingRow>> {
  const rows = await readWithTimeout<AssessedDosingRow[]>(() => {
    const matched = filterRows(listRows(DOSING_KEY), query.filters ?? {}).filter((row) =>
      inPeriod(row, query.startDate, query.endDate),
    )
    return assessRows(matched)
  }, '混凝加药台账读取卡住，请重试一次')

  return { items: rows, total: rows.length, page: 1, size: rows.length }
}

function createRejectionMaintenance(code: string, category: string, conclusion: string): void {
  const rows = listRows(MAINTENANCE_KEY)
  const duplicated = rows.some(
    (row) =>
      String(row['维护设备']) === `混凝加药录入链路（${code}）` &&
      String(row['维护类别']) === category &&
      row.status !== '已完工',
  )
  if (duplicated) {
    return
  }

  const id = nextId(rows)
  const row: EntryRow = {
    id,
    status: '待开工',
    pending: true,
    abnormal: true,
    维护编号: moduleCode('EQUI', id),
    维护设备: `混凝加药录入链路（${code}）`,
    维护类别: category,
    维护班组: '仪表维护班',
    计划工期: '本班内核查',
    完工日期: '',
    更换配件: conclusion,
    维护状态: '待开工',
  }
  saveRows(MAINTENANCE_KEY, [...rows, row])
}

export function submitDosingRecord(input: DosingForm): ActionResult {
  const form = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, String(value ?? '').trim()]),
  ) as DosingForm

  const missing = REQUIRED_FIELDS.filter(({ key }) => form[key] === '')
  if (missing.length > 0) {
    const labels = missing.map((item) => item.label)
    const hardMissing = missing
      .map((item) => item.label)
      .filter((label) => label === '投加浓度' || label === '加药量')
    if (hardMissing.length > 0) {
      const code = form['加药编号'] || '未编号'
      const conclusion = `加药单已退回：缺少 ${hardMissing.join('、')}，需核查录入链路和计量仪表。`
      createRejectionMaintenance(code, `加药单字段缺失：${hardMissing.join('、')}`, conclusion)
    }
    return { ok: false, message: `加药单已退回，缺少：${labels.join('、')}。请补齐后重新报送。` }
  }

  const code = form['加药编号']
  const duplicated = listRows(DOSING_KEY).some((row) => String(row['加药编号']) === code)
  if (duplicated) {
    return {
      ok: false,
      duplicate: true,
      message: `加药编号 ${code} 已登记，本次重复报送只保留原记录一次。`,
    }
  }

  const turbidity = normalizeTurbidity(form['原水浊度'])
  const concentration = normalizeConcentration(form['投加浓度'])
  const amount = parsePositiveAmount(form['加药量'])
  const invalidReasons = [
    turbidity.valid ? '' : turbidity.reason,
    concentration.valid ? '' : concentration.reason,
    amount.valid ? '' : amount.reason,
  ].filter(Boolean)

  if (invalidReasons.length > 0) {
    const conclusion = `加药单已退回：${invalidReasons.join('；')}。`
    createRejectionMaintenance(code, '加药单读数不可识别', conclusion)
    return { ok: false, message: conclusion }
  }

  const recommendation = recommendConcentration(turbidity)
  const reasons = [turbidity.reason, concentration.reason].filter(Boolean)
  const abnormal = turbidity.abnormal || concentration.abnormal
  const status: string = concentration.abnormal ? '浓度异常' : '待投加'
  const rows = listRows(DOSING_KEY)
  const id = nextId(rows)
  const row: EntryRow = {
    id,
    status,
    pending: status !== '已批复',
    abnormal,
    加药编号: code,
    加药药剂: form['加药药剂'],
    投加浓度: form['投加浓度'],
    加药量: form['加药量'],
    原水浊度: form['原水浊度'],
    操作人员: form['操作人员'],
    加药时间: form['加药时间'],
    加药状态: status,
    标准浊度: `${turbidity.value} ${turbidity.unit}`,
    标准浓度: `${concentration.value} ${concentration.unit}`,
    异常标注: reasons.join('；'),
    判定依据: `原水浊度：${turbidity.basis}；投加浓度：${concentration.basis}；参考依据：${recommendation.basis}`,
  }
  saveRows(DOSING_KEY, [...rows, row])

  return {
    ok: true,
    message: abnormal
      ? `加药单 ${code} 已入库，异常读数已单独标注，请复核计量仪表。`
      : `加药单 ${code} 已入库。`,
  }
}

function currentDay(): string {
  return new Date().toISOString().slice(0, 10)
}

function appendShiftHandover(code: string, agent: string, conclusion: string): void {
  const rows = listRows(SHIFT_KEY)
  const activeIndex = rows.findIndex((row) => ['待交接', '交接中'].includes(String(row.status)))
  if (activeIndex >= 0) {
    const current = rows[activeIndex]
    const next: EntryRow = {
      ...current,
      交接事项: `${String(current['交接事项'] ?? '')}；${conclusion}`,
    }
    const nextRows = [...rows]
    nextRows[activeIndex] = next
    saveRows(SHIFT_KEY, nextRows)
    return
  }

  const id = nextId(rows)
  const row: EntryRow = {
    id,
    status: '交接中',
    pending: true,
    abnormal: false,
    交接编号: moduleCode('SHIF', id),
    值班班组: '当班班组',
    班次: '当班',
    交班人员: '值班管理员',
    接班人员: '接班值班员',
    交接事项: conclusion,
    交接时间: currentDay(),
    交接状态: '交接中',
  }
  saveRows(SHIFT_KEY, [...rows, row])
}

function approveDosingRecord(id: number): ActionResult {
  const rows = listRows(DOSING_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的混凝加药记录` }
  }

  const current = rows[index]
  if (current.status === '已批复') {
    return { ok: false, message: `加药编号 ${current['加药编号']} 已批复，不用重复操作` }
  }
  if (!['已投加', '浓度异常'].includes(String(current.status))) {
    return { ok: false, message: '请先确认投加完成，再进行加药药剂判定批复' }
  }

  const turbidity = normalizeTurbidity(String(current['原水浊度'] ?? ''))
  const concentration = normalizeConcentration(String(current['投加浓度'] ?? ''))
  const recommendation = recommendConcentration(turbidity)
  const abnormal = Boolean(current.abnormal) || turbidity.abnormal || concentration.abnormal
  const code = String(current['加药编号'])
  const agent = String(current['加药药剂'])
  const abnormalText = abnormal ? '读数异常，批复后仍须复核仪表' : '判定同意'
  const basis = `原水浊度：${turbidity.valid ? turbidity.value : '未识别'}NTU；投加浓度：${
    concentration.valid ? concentration.value : '未识别'
  }mg/L；参考区间：${recommendation.range}；依据：${turbidity.basis}；${concentration.basis}`
  const conclusion = `加药批复：${code}（${agent}）${abnormalText}；${basis}`

  const next: EntryRow = {
    ...current,
    status: '已批复',
    pending: false,
    abnormal,
    加药状态: '已批复',
    异常标注: abnormal
      ? String(current['异常标注'] ?? '') || [turbidity.reason, concentration.reason].filter(Boolean).join('；')
      : String(current['异常标注'] ?? ''),
    判定依据: basis,
  }
  const nextRows = [...rows]
  nextRows[index] = next
  saveRows(DOSING_KEY, nextRows)
  appendShiftHandover(code, agent, conclusion)

  return { ok: true, message: `加药编号 ${code} 已批复，并已回写值班交接。` }
}

export function runDosingAction(id: number, action: string): ActionResult {
  if (action === '判定批复') {
    return approveDosingRecord(id)
  }

  const result = runAction(DOSING_KEY, id, action)
  if (!result.ok) {
    return result
  }

  const rows = listRows(DOSING_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index >= 0) {
    const assessed = assessRow(rows[index])
    const next: EntryRow = {
      ...rows[index],
      abnormal: action === '标记异常' || assessed.abnormal,
      pending: rows[index].status !== '已批复',
      异常标注:
        action === '标记异常' && !assessed.异常标注
          ? '值班人员已人工标记为异常'
          : assessed.异常标注,
      判定依据: assessed.判定依据,
      标准浊度: assessed.标准浊度,
      标准浓度: assessed.标准浓度,
    }
    const nextRows = [...rows]
    nextRows[index] = next
    saveRows(DOSING_KEY, nextRows)
  }
  return result
}

export function exportDosingEntries(): { filename: string; content: string } {
  const rows = assessRows(listRows(DOSING_KEY))
  const header = [
    '编号',
    '加药编号',
    '加药药剂',
    '投加浓度',
    '加药量',
    '原水浊度',
    '标准浊度',
    '标准浓度',
    '异常标注',
    '判定依据',
    '操作人员',
    '加药时间',
    '当前状态',
  ]
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row['加药编号'],
        row['加药药剂'],
        row['投加浓度'],
        row['加药量'],
        row['原水浊度'],
        row['标准浊度'],
        row['标准浓度'],
        row['异常标注'],
        row['判定依据'],
        row['操作人员'],
        row['加药时间'],
        row.status,
      ].join(','),
    )
  }
  return { filename: '混凝加药-台账.csv', content: `﻿${lines.join('\n')}` }
}
