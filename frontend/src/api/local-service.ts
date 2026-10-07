import { DOSING_RULE_VERSION, DOSING_SPECS, normalizeDosingReading } from '@/data/dosing-rules'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

/** 加药单提交：录入页只收集原始读数，判定、换算、回写都在这里完成。 */
export type DosingSubmitInput = {
  加药编号: string
  加药药剂: string
  投加浓度: string
  加药量: string
  原水浊度: string
  操作人员: string
  加药时间: string
}

export type DosingDecision = '通过' | '退回' | '挡回' | '重复'

export type DosingSubmitResult = ActionResult & {
  decision: DosingDecision
  加药编号?: string
}

export type DosingListFilters = {
  加药编号?: string
  加药药剂?: string
  from?: string
  to?: string
}

// 读取故障演练开关：供新来的值班员验证「读取卡住 → 提示 → 重试一次」这条路径，
// 置位后下一次读取抛错并自动解除，所以重试必定成功。
let dosingReadFaultArmed = false

export function armDosingReadFaultOnce(): void {
  dosingReadFaultArmed = true
}

function guardDosingRead(): void {
  if (dosingReadFaultArmed) {
    dosingReadFaultArmed = false
    throw new Error('混凝加药台账读取超时（演练故障），请重试一次')
  }
}

function nextRowId(key: string): number {
  return listRows(key).reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 加药台账列表：编号/药剂走通用模糊筛选，加药时间按 [from, to] 闭区间过滤。
 * 读取前先过故障闸门，模拟台账读不出来的场景。
 */
export function listDosingEntries(filters: DosingListFilters = {}): PageResult {
  guardDosingRead()
  let matched = listRows('dosing')
  const 编号 = (filters.加药编号 ?? '').trim()
  const 药剂 = (filters.加药药剂 ?? '').trim()
  if (编号) {
    matched = matched.filter((row) => String(row['加药编号'] ?? '').includes(编号))
  }
  if (药剂) {
    matched = matched.filter((row) => String(row['加药药剂'] ?? '').includes(药剂))
  }
  const from = (filters.from ?? '').trim()
  const to = (filters.to ?? '').trim()
  if (from || to) {
    matched = matched.filter((row) => {
      const day = String(row['加药时间'] ?? '').slice(0, 10)
      return (!from || day >= from) && (!to || day <= to)
    })
  }
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function nextDosingNo(): string {
  const seq = nextRowId('dosing')
  return `DOSI-${String(seq).padStart(4, '0')}`
}

/**
 * 台账与明细对账：统计卡片（台账口径）与表格行（明细口径）必须来自同一份明细，
 * 四个状态桶之和应等于明细总条数。重试之后再对一次，数字对不上就不展示旧数。
 */
export function reconcileDosing(items: EntryRow[]): { ledgerTotal: number; detailTotal: number; aligned: boolean } {
  const meta = MODULE_BY_KEY.get('dosing')
  const ledgerTotal = meta
    ? meta.statuses.reduce((sum, status) => sum + items.filter((row) => String(row.status) === status).length, 0)
    : 0
  const detailTotal = items.length
  return { ledgerTotal, detailTotal, aligned: ledgerTotal === detailTotal }
}

/** 挡回/退回结论落到设备维护待办，维护班组按待开工跟进。 */
function createMaintTodo(category: string, device: string, content: string): string {
  const rows = listRows('equipmaint')
  const id = nextRowId('equipmaint')
  const 维护编号 = `EQUI-TODO-${String(id).padStart(4, '0')}`
  const todo: EntryRow = {
    id,
    status: '待开工',
    pending: true,
    abnormal: false,
    维护编号,
    维护设备: device,
    维护类别: category,
    维护班组: '',
    计划工期: today(),
    完工日期: '',
    更换配件: content,
    维护状态: '待开工',
  }
  saveRows('equipmaint', [...rows, todo])
  return 维护编号
}

/** 加药药剂的判定批复回写到最新一条值班交接记录；有挡回/退回时挂成遗留事项。 */
function appendShiftNote(note: string, pending: boolean): string {
  const rows = listRows('shift')
  const latest = rows.reduce<EntryRow | null>(
    (found, row) => (found === null || Number(row.id) > Number(found.id) ? row : found),
    null,
  )
  if (!latest) {
    return ''
  }
  const previous = String(latest['交接事项'] ?? '')
  const 交接事项 = previous === '' || previous.includes('样例') ? note : `${previous}；${note}`
  const status = pending ? '有遗留' : String(latest.status)
  const updated: EntryRow = {
    ...latest,
    交接事项,
    status,
    pending: pending || Boolean(latest.pending),
    abnormal: pending || Boolean(latest.abnormal),
    交接状态: status,
  }
  saveRows('shift', rows.map((row) => (Number(row.id) === Number(updated.id) ? updated : row)))
  return String(latest['交接编号'] ?? '')
}

/**
 * 提交一张加药单，录入路径的判定顺序：
 * 1) 投加浓度/加药量（连同编号、药剂）空着 → 退回，逐条写明缺项，不入库；
 * 2) 同一加药编号重复报送 → 只记一次，本次不入库；
 * 3) 原水浊度/投加浓度/加药量按统一规则换算，异常读数入台账并单独标注、写依据，单子挡回；
 * 4) 全部正常 → 判定通过入台账。批复一律回写交接；退回/挡回再落设备维护待办。
 */
export function submitDosingRecord(input: DosingSubmitInput): DosingSubmitResult {
  const 编号 = input.加药编号.trim()
  const 药剂 = input.加药药剂.trim()
  const 时间 = input.加药时间.replace('T', ' ').trim()

  // 1) 缺项先退回：缺什么写什么，缺项单绝不入库。
  const missing: string[] = []
  if (!编号) missing.push('加药编号')
  if (!药剂) missing.push('加药药剂')
  if (input.投加浓度.trim() === '') missing.push('投加浓度')
  if (input.加药量.trim() === '') missing.push('加药量')
  if (missing.length > 0) {
    const maintNo = createMaintTodo(
      '加药单退回待办',
      编号 ? `混凝加药记录${编号}` : '混凝加药记录（编号未填）',
      `加药单${编号 ? ` ${编号}` : ''}缺项退回，缺：${missing.join('、')}，请联系值班员补全后重新报送。`,
    )
    const note = `【加药批复·退回】${today()}${编号 ? ` 加药单 ${编号}` : ' 未填编号加药单'}缺：${missing.join('、')}，退回补录，待办 ${maintNo}。`
    const shiftNo = appendShiftNote(note, true)
    return {
      ok: false,
      decision: '退回',
      加药编号: 编号,
      message: `加药单退回：缺少${missing.join('、')}，请补全后重新报送（本次未入库）。退回结论已登记设备维护待办 ${maintNo}，并回写交接记录 ${shiftNo}。`,
    }
  }

  // 2) 同一加药编号重复报送：只记一次。
  const duplicated = listRows('dosing').find((row) => String(row['加药编号'] ?? '') === 编号)
  if (duplicated) {
    return {
      ok: false,
      decision: '重复',
      加药编号: 编号,
      message: `加药编号 ${编号} 已登记（${duplicated['加药药剂']}，状态「${duplicated.status}」），同一条报送只记一次，本次不重复入库。`,
    }
  }

  // 3) 三项读数走同一套换算规则；浊度可空，空着不参与判异。
  const concentration = normalizeDosingReading('concentration', input.投加浓度)
  const dosage = normalizeDosingReading('dosage', input.加药量)
  const turbidity = normalizeDosingReading('turbidity', input.原水浊度)
  const checks = [concentration, dosage, ...(turbidity.raw === '' ? [] : [turbidity])]
  const abnormalOnes = checks.filter((item) => item.abnormal)
  const blocked = abnormalOnes.length > 0

  const readingText = (item: (typeof checks)[number]): string =>
    item.value === null ? item.raw : `${item.value}${item.unit}`
  const reasons = abnormalOnes.map((item) => `${item.label}${item.reason}`)
  const basis = abnormalOnes.map((item) => item.basis).filter(Boolean).join('；')

  const status = blocked ? '浓度异常' : '待投加'
  const row: EntryRow = {
    id: nextRowId('dosing'),
    status,
    pending: true,
    abnormal: blocked,
    加药编号: 编号,
    加药药剂: 药剂,
    投加浓度: readingText(concentration),
    加药量: readingText(dosage),
    原水浊度: turbidity.raw === '' ? '' : readingText(turbidity),
    操作人员: input.操作人员.trim(),
    加药时间: 时间,
    加药状态: status,
    异常标注: blocked ? reasons.join('；') : '',
    判定依据: blocked
      ? `${basis}（换算规则：${DOSING_RULE_VERSION}；${DOSING_SPECS.concentration.label}与${DOSING_SPECS.turbidity.label}同一套换算）`
      : '',
  }
  saveRows('dosing', [...listRows('dosing'), row])

  if (blocked) {
    const maintNo = createMaintTodo(
      '异常读数核查',
      `混凝加药记录${编号}`,
      `加药单 ${编号}（${药剂}）异常挡回：${reasons.join('；')}。请核查计量泵/浊度仪读数并校准后重新投加。依据见台账「判定依据」栏。`,
    )
    const note = `【加药批复·挡回】${时间 || today()} 加药单 ${编号} ${药剂} 异常挡回：${reasons.join('；')}，已单独标注并写明依据，待办 ${maintNo}。`
    const shiftNo = appendShiftNote(note, true)
    return {
      ok: false,
      decision: '挡回',
      加药编号: 编号,
      message: `加药单 ${编号}（${药剂}）被挡回：${reasons.join('；')}。异常读数已入台账单独标注并写出依据，设备维护待办 ${maintNo} 已登记，批复已回写交接记录 ${shiftNo}，核查前不得投加。`,
    }
  }

  // 4) 判定通过。
  const note = `【加药批复】${时间 || today()} 加药单 ${编号} ${药剂} 判定通过（投加浓度 ${readingText(concentration)}，加药量 ${readingText(dosage)}${
    turbidity.raw === '' ? '' : `，原水浊度 ${readingText(turbidity)}`
  }），已入台账待投加。`
  const shiftNo = appendShiftNote(note, false)
  return {
    ok: true,
    decision: '通过',
    加药编号: 编号,
    message: `加药单 ${编号}（${药剂}）判定通过，已入台账（待投加）。批复已回写交接记录 ${shiftNo}。`,
  }
}


export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
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

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
