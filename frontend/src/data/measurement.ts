// 原水浊度与投加浓度共用一套解析、单位换算和异常判定，避免两处各写一套口径。

export type NormalizedMeasure = {
  value: number
  unit: string
  valid: boolean
  abnormal: boolean
  reason: string
  basis: string
}

type MeasureRule = {
  kind: '浊度' | '浓度'
  units: Record<string, number>
  defaultUnit: string
  min: number
  max: number
  abnormalMax: number
  ruleText: string
}

const TURBIDITY_RULE: MeasureRule = {
  kind: '浊度',
  units: {
    NTU: 1,
    ntu: 1,
    度: 1,
  },
  defaultUnit: 'NTU',
  min: 0,
  max: 1000,
  abnormalMax: 1000,
  ruleText: '浊度统一换算为 NTU；按 0–1000 NTU 为可读区间，超过 1000 NTU 标为异常读数',
}

const CONCENTRATION_RULE: MeasureRule = {
  kind: '浓度',
  units: {
    'mg/L': 1,
    'mg/l': 1,
    ppm: 1,
    '%': 10000,
  },
  defaultUnit: 'mg/L',
  min: 0,
  max: 100,
  abnormalMax: 100,
  ruleText: '浓度统一换算为 mg/L；ppm 按 1:1，百分浓度按 1%=10000mg/L；0–100mg/L 为可读区间',
}

function buildMeasure(raw: string, rule: MeasureRule): NormalizedMeasure {
  const text = raw.trim()
  const match = text.match(/^(-?\d+(?:\.\d+)?)(.*)$/)
  if (!match) {
    return {
      value: Number.NaN,
      unit: rule.defaultUnit,
      valid: false,
      abnormal: false,
      reason: `${rule.kind}读数无法识别，请按“数值+单位”填写`,
      basis: rule.ruleText,
    }
  }

  const inputValue = Number(match[1])
  const inputUnit = match[2].trim() || rule.defaultUnit
  const factor = rule.units[inputUnit]
  if (factor === undefined) {
    return {
      value: Number.NaN,
      unit: rule.defaultUnit,
      valid: false,
      abnormal: false,
      reason: `${rule.kind}单位“${inputUnit}”不在统一换算口径内`,
      basis: rule.ruleText,
    }
  }

  const value = Number((inputValue * factor).toFixed(4))
  if (!Number.isFinite(value) || inputValue < rule.min) {
    return {
      value,
      unit: rule.defaultUnit,
      valid: false,
      abnormal: false,
      reason: `${rule.kind}读数不能小于 0`,
      basis: rule.ruleText,
    }
  }

  const abnormal = value > rule.abnormalMax
  return {
    value,
    unit: rule.defaultUnit,
    valid: true,
    abnormal,
    reason: abnormal ? `${rule.kind}读数 ${value}${rule.defaultUnit} 超过 ${rule.abnormalMax}${rule.defaultUnit} 判定阈值` : '',
    basis: abnormal ? `${text} → ${value}${rule.defaultUnit}；${rule.ruleText}` : rule.ruleText,
  }
}

export function normalizeTurbidity(raw: string): NormalizedMeasure {
  return buildMeasure(raw, TURBIDITY_RULE)
}

export function normalizeConcentration(raw: string): NormalizedMeasure {
  return buildMeasure(raw, CONCENTRATION_RULE)
}

export function parsePositiveAmount(raw: string): { value: number; valid: boolean; reason: string } {
  const text = raw.trim()
  const match = text.match(/^(-?\d+(?:\.\d+)?)(.*)$/)
  if (!match) {
    return { value: Number.NaN, valid: false, reason: '加药量无法识别，请填写正数（可带单位）' }
  }
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) {
    return { value, valid: false, reason: '加药量必须大于 0' }
  }
  return { value, valid: true, reason: '' }
}

export function recommendConcentration(turbidity: NormalizedMeasure): {
  range: string
  basis: string
} {
  if (!turbidity.valid) {
    return { range: '无法推荐', basis: '原水浊度未通过统一换算，不能据此给出投加浓度建议' }
  }
  if (turbidity.value <= 50) {
    return { range: '5–15mg/L', basis: '原水浊度 0–50NTU 的混凝剂投加浓度样例区间：5–15mg/L' }
  }
  if (turbidity.value <= 500) {
    return { range: '15–40mg/L', basis: '原水浊度 51–500NTU 的混凝剂投加浓度样例区间：15–40mg/L' }
  }
  return { range: '40–80mg/L', basis: '原水浊度 501–1000NTU 的混凝剂投加浓度样例区间：40–80mg/L；超过阈值时须复核原水仪表' }
}
