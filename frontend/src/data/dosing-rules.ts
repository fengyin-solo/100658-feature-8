/**
 * 加药读数统一换算规则：原水浊度、投加浓度、加药量都走同一套
 * 「解析数值 → 统一单位 → 区间判异」管线，换后端时这一套规则可以原样搬走。
 *
 * 同一条规则在录入预览、提交校验两处共用，保证界面看到的判定和入库的判定一致。
 */

export const DOSING_RULE_VERSION = '加药读数规则 v1（2026-10 生效）'

export type DosingReadingKind = 'turbidity' | 'concentration' | 'dosage'

export type DosingSpec = {
  kind: DosingReadingKind
  label: string
  canonicalUnit: string
  unitAliases: Record<string, number>
  /** 合法（不判异常）区间：低于下限或高于上限都单独标注。 */
  normalRange: { min: number; max: number }
}

export const DOSING_SPECS: Record<DosingReadingKind, DosingSpec> = {
  // 原水浊度：法定计量单位 NTU，江河原水常态在个位到几百 NTU。
  turbidity: {
    kind: 'turbidity',
    label: '原水浊度',
    canonicalUnit: 'NTU',
    unitAliases: { NTU: 1, ntu: 1 },
    normalRange: { min: 0, max: 1000 },
  },
  // 投加浓度：混凝剂以 mg/L（克/吨水）计，0.1 mg/L 以下投不匀、100 mg/L 以上视为配药异常。
  concentration: {
    kind: 'concentration',
    label: '投加浓度',
    canonicalUnit: 'mg/L',
    unitAliases: { 'mg/L': 1, mg: 1, 'g/m³': 1, '克/吨': 1, '%': 10000 },
    normalRange: { min: 0.1, max: 100 },
  },
  // 加药量：本班次（或该时段）投加药剂质量，以 kg 计。
  dosage: {
    kind: 'dosage',
    label: '加药量',
    canonicalUnit: 'kg',
    unitAliases: { kg: 1, KG: 1, 公斤: 1, t: 1000, 吨: 1000, g: 0.001, 克: 0.001 },
    normalRange: { min: 0.01, max: 2000 },
  },
}

export type NormalizedReading = {
  kind: DosingReadingKind
  label: string
  raw: string
  /** 统一到 canonicalUnit 后的数值，保留两位小数；解析失败时为 null。 */
  value: number | null
  unit: string
  abnormal: boolean
  reason: string
  basis: string
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 统一换算入口。空串交回 missing=true 由上层按「缺项退回」处理；
 * 解析不出数值或换算后越界，标 abnormal 并写清判定依据。
 */
export function normalizeDosingReading(kind: DosingReadingKind, rawInput: string | number | null | undefined): NormalizedReading {
  const spec = DOSING_SPECS[kind]
  const raw = String(rawInput ?? '').trim()
  const base: NormalizedReading = {
    kind,
    label: spec.label,
    raw,
    value: null,
    unit: spec.canonicalUnit,
    abnormal: false,
    reason: '',
    basis: '',
  }
  if (raw === '') {
    return { ...base, reason: `未填写${spec.label}` }
  }

  const match = raw.match(/(-?\d+(?:\.\d+)?)\s*([^\s]*)/)
  if (!match) {
    return {
      ...base,
      abnormal: true,
      reason: '读数无法解析',
      basis: `${spec.label}「${raw}」无法解析为数值与单位，按${DOSING_RULE_VERSION}判为异常读数。`,
    }
  }

  const parsed = Number(match[1])
  const inputUnit = match[2]
  const factor = inputUnit === '' ? 1 : spec.unitAliases[inputUnit]
  if (inputUnit !== '' && factor === undefined) {
    return {
      ...base,
      abnormal: true,
      reason: `单位「${inputUnit}」不在换算表`,
      basis: `${spec.label}「${raw}」使用的单位 ${inputUnit} 不在${spec.canonicalUnit}换算表内，无法统一换算，按${DOSING_RULE_VERSION}判为异常读数。`,
    }
  }

  const value = round2(parsed * (factor ?? 1))
  if (!Number.isFinite(value) || value < 0) {
    return {
      ...base,
      unit: inputUnit || spec.canonicalUnit,
      abnormal: true,
      reason: '读数为负数或非有限数',
      basis: `${spec.label}「${raw}」换算后为 ${value} ${spec.canonicalUnit}，物理读数不允许为负，按${DOSING_RULE_VERSION}判为异常读数。`,
    }
  }

  const { min, max } = spec.normalRange
  if (value < min || value > max) {
    return {
      ...base,
      value,
      unit: spec.canonicalUnit,
      abnormal: true,
      reason: `超出${spec.label}正常区间`,
      basis: `${spec.label}「${raw}」换算为 ${value} ${spec.canonicalUnit}，超出${DOSING_RULE_VERSION}规定的正常区间 ${min}~${max} ${spec.canonicalUnit}，判为异常读数。`,
    }
  }

  return { ...base, value, unit: spec.canonicalUnit }
}
