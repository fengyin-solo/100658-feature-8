/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult<T = EntryRow> = {
  items: T[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  duplicate?: boolean
}

export type DosingForm = {
  加药编号: string
  加药药剂: string
  投加浓度: string
  加药量: string
  原水浊度: string
  操作人员: string
  加药时间: string
}

export type DosingQuery = {
  filters?: Record<string, string>
  startDate?: string
  endDate?: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
