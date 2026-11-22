/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Main } from '@/components/layout'
import { Combobox } from '@/components/ui/combobox'
import { QUOTA_TYPE_VALUES } from '@/features/pricing/constants'
import { usePricingData } from '@/features/pricing/hooks/use-pricing-data'
import { parseTiersFromExpr } from '@/features/pricing/lib/billing-expr'
import type { ParsedTier } from '@/features/pricing/lib/billing-expr'
import { formatBillingCondition } from '@/features/pricing/lib/billing-expression/condition-display'
import { getConfiguredGroupRatio } from '@/features/pricing/lib/model-helpers'
import type { PricingModel } from '@/features/pricing/types'
import { useProfile } from '@/features/profile/hooks'
import { formatBillingCurrencyFromUSD, getCurrencyLabel } from '@/lib/currency'
import { cn } from '@/lib/utils'

import { getSelfModelDiscounts } from './api'
import { WILDCARD_MODEL } from './types'
import type { ModelDiscountRecord } from './types'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

type Category = 'all' | 'text' | 'multimodal' | 'image' | 'video'

const CATEGORY_TABS: { key: Category; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'text', label: '文本' },
  { key: 'multimodal', label: '多模态' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
]

const CONDITION_VAR_LABELS: Record<string, string> = {
  p: '输入 Token',
  c: '输出 Token',
  len: '总 Token 数',
}

const OPERATOR_LABELS: Record<string, string> = {
  '>=': '≥',
  '<=': '≤',
  '>': '>',
  '<': '<',
}

/** 常见时区的中文别名，避免直接露出 IANA 标识 */
const TIMEZONE_LABELS: Record<string, string> = {
  'Asia/Shanghai': '北京时间',
  UTC: 'UTC',
  'Asia/Tokyo': '日本时间',
  'Asia/Seoul': '首尔时间',
  'Asia/Singapore': '新加坡时间',
  'Europe/London': '伦敦时间',
  'Europe/Berlin': '柏林时间',
  'America/New_York': '纽约时间',
  'America/Chicago': '芝加哥时间',
  'America/Los_Angeles': '洛杉矶时间',
  'Australia/Sydney': '悉尼时间',
}

function categoryOf(model: PricingModel): Exclude<Category, 'all'> {
  const mods = new Set<string>([
    ...(model.input_modalities ?? []),
    ...(model.output_modalities ?? []),
  ])
  if (mods.has('video')) return 'video'
  if (mods.has('image')) {
    return model.quota_type === QUOTA_TYPE_VALUES.REQUEST
      ? 'image'
      : 'multimodal'
  }
  if (mods.has('audio')) return 'multimodal'
  return 'text'
}

function isNeutral(record: ModelDiscountRecord): boolean {
  return (
    record.discount_input >= 1 &&
    record.discount_output >= 1 &&
    record.discount_cache >= 1 &&
    record.discount_image >= 1 &&
    record.discount_audio >= 1 &&
    record.discount_fixed >= 1
  )
}

/** 0.45 → 4.5折 */
function zheLabel(rate: number): string {
  const zhe = Math.round(rate * 100) / 10
  return `${zhe}折`
}

/** 取一条配置里最深的分项折扣，用于「默认折扣」提示 */
function lowestRate(record: ModelDiscountRecord): number {
  const rates = [
    record.discount_input,
    record.discount_output,
    record.discount_cache,
    record.discount_image,
    record.discount_audio,
    record.discount_fixed,
  ].filter((r) => Number.isFinite(r) && r < 1)
  if (rates.length === 0) return 1
  return Math.min(...rates)
}

function money(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return formatBillingCurrencyFromUSD(value, {
    digitsLarge: 4,
    digitsSmall: 6,
    abbreviate: false,
  })
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 0 与缺省不同：表达式里显式写 0 代表免费 */
function scaled(
  value: number | undefined,
  groupRatio: number,
  discount: number
): PriceItem | undefined {
  if (value == null) return undefined
  const original = value * groupRatio
  return { original, discounted: original * discount, rate: discount }
}

type PriceItem = { original: number; discounted: number; rate: number }

/** 折后价 + 绿色折扣标签，原价通过悬停提示 */
function PriceWithDiscount({ item }: { item?: PriceItem }) {
  if (!item || !Number.isFinite(item.discounted)) {
    return <span className='text-muted-foreground text-xs'>—</span>
  }
  return (
    <span
      className='inline-flex items-center justify-end gap-1.5'
      title={`${money(item.original)}`}
    >
      <span className='font-mono text-sm tabular-nums'>
        {money(item.discounted)}
      </span>
      {item.rate < 1 && (
        <span className='rounded-full border border-emerald-500/50 px-1.5 py-[1px] text-[11px] leading-4 text-emerald-600 dark:text-emerald-400'>
          {zheLabel(item.rate)}
        </span>
      )}
    </span>
  )
}

interface PriceSet {
  input?: PriceItem
  output?: PriceItem
  cache?: PriceItem
  cacheCreate?: PriceItem
  image?: PriceItem
  audio?: PriceItem
  fixed?: PriceItem
}

/** 传统倍率模型的单价：model_ratio × 2 × 分组倍率 */
function buildRatioPrices(
  model: PricingModel,
  record: ModelDiscountRecord,
  groupRatio: number
): PriceSet {
  if (model.quota_type === QUOTA_TYPE_VALUES.REQUEST) {
    return {
      fixed: scaled(model.model_price ?? 0, groupRatio, record.discount_fixed),
    }
  }

  const inputUnit = (model.model_ratio ?? 0) * 2 * groupRatio
  const inputItem: PriceItem = {
    original: inputUnit,
    discounted: inputUnit * record.discount_input,
    rate: record.discount_input,
  }
  const prices: PriceSet = { input: inputItem }

  if (Number.isFinite(model.completion_ratio)) {
    const ratio = Number(model.completion_ratio)
    prices.output = {
      original: inputUnit * ratio,
      discounted:
        inputUnit * record.discount_input * ratio * record.discount_output,
      rate: record.discount_output,
    }
  }

  if (model.cache_ratio != null) {
    prices.cache = {
      original: inputUnit * Number(model.cache_ratio),
      discounted:
        inputUnit *
        record.discount_input *
        Number(model.cache_ratio) *
        record.discount_cache,
      rate: record.discount_cache,
    }
  }

  if (model.create_cache_ratio != null) {
    prices.cacheCreate = {
      original: inputUnit * Number(model.create_cache_ratio),
      discounted:
        inputUnit *
        record.discount_input *
        Number(model.create_cache_ratio) *
        record.discount_cache,
      rate: record.discount_cache,
    }
  }

  if (model.image_ratio != null) {
    prices.image = {
      original: inputUnit * Number(model.image_ratio),
      discounted:
        inputUnit *
        record.discount_input *
        Number(model.image_ratio) *
        record.discount_image,
      rate: record.discount_image,
    }
  }

  if (model.audio_ratio != null) {
    prices.audio = {
      original: inputUnit * Number(model.audio_ratio),
      discounted:
        inputUnit *
        record.discount_input *
        Number(model.audio_ratio) *
        record.discount_audio,
      rate: record.discount_audio,
    }
  }

  return prices
}

/** 阶梯 / 时段表达式模型：表达式里的单价本身就是每百万 Token 的美元值 */
function buildTierPrices(
  tier: ParsedTier,
  record: ModelDiscountRecord,
  groupRatio: number
): PriceSet {
  if (tier.billingUnit === 'request') {
    const fixed = finiteNumber(tier.fixedPrice) ?? 0
    return { fixed: scaled(fixed, groupRatio, record.discount_fixed) }
  }

  const input = finiteNumber(tier.inputPrice)
  const prices: PriceSet = {}
  if (input != null)
    prices.input = scaled(input, groupRatio, record.discount_input)

  const output = finiteNumber(tier.outputPrice)
  if (output != null) {
    prices.output = scaled(output, groupRatio, record.discount_output)
  }

  const cacheRead = finiteNumber(tier.cacheReadPrice)
  if (cacheRead != null) {
    prices.cache = scaled(cacheRead, groupRatio, record.discount_cache)
  }

  const cacheCreate = finiteNumber(tier.cacheCreatePrice)
  if (cacheCreate != null) {
    prices.cacheCreate = scaled(cacheCreate, groupRatio, record.discount_cache)
  }

  const image = finiteNumber(tier.imagePrice)
  if (image != null)
    prices.image = scaled(image, groupRatio, record.discount_image)

  const audio = finiteNumber(tier.audioInputPrice)
  if (audio != null)
    prices.audio = scaled(audio, groupRatio, record.discount_audio)

  return prices
}

/** 把 p / len 的阈值条件拼成「总 Token 数 ≥ 0；总 Token 数 ≤ 1000000」 */
function conditionText(tier: ParsedTier, locale: string): string | undefined {
  const list = tier.conditions ?? []
  if (list.length > 0) {
    return list
      .map((condition) => {
        const label = CONDITION_VAR_LABELS[condition.var] ?? condition.var
        const operator = OPERATOR_LABELS[condition.op] ?? condition.op
        return `${label} ${operator} ${condition.value.toLocaleString(locale)}`
      })
      .join('；')
  }
  return undefined
}

function timezoneLabel(text: string): string {
  let result = text
  for (const [key, label] of Object.entries(TIMEZONE_LABELS)) {
    result = result.split(`(${key})`).join(`（${label}）`)
  }
  return result
}

type PriceLine = {
  key: string
  /** 该行对应的条件文案，展示为「适用条件」 */
  condition?: string
  /** 时段行，橙色底 + 「高峰期」标记 */
  peak?: boolean
}

type RowData = {
  model: PricingModel
  discount: ModelDiscountRecord
  matched: 'exact' | 'wildcard'
}

type LineData = PriceLine & { prices: PriceSet }

/** 一个模型可能展开成多行（基础 / 阶梯 / 高峰时段） */
function buildLines(
  model: PricingModel,
  record: ModelDiscountRecord,
  group: string,
  translate: (key: string, options?: Record<string, unknown>) => string,
  locale: string
): LineData[] {
  const groupRatio = getConfiguredGroupRatio(model.group_ratio ?? {}, group)

  if (model.billing_mode === 'tiered_expr' && model.billing_expr) {
    const tiers = parseTiersFromExpr(model.billing_expr)
    if (tiers.length > 0) {
      const timeBased = tiers.some((tier) =>
        (tier.conditionText ?? '').includes('hour(')
      )
      const maxInput = Math.max(
        ...tiers.map((tier) => finiteNumber(tier.inputPrice) ?? 0)
      )
      return tiers.map((tier, index) => {
        const rawCondition = tier.conditionText
          ? formatBillingCondition(tier.conditionText, translate, locale)
          : null
        const peak =
          timeBased &&
          tiers.length > 1 &&
          (finiteNumber(tier.inputPrice) ?? 0) === maxInput
        return {
          key: `${tier.label}-${index}`,
          condition:
            conditionText(tier, locale) ??
            (rawCondition ? timezoneLabel(rawCondition) : undefined),
          peak,
          prices: buildTierPrices(tier, record, groupRatio),
        }
      })
    }
  }

  return [{ key: 'base', prices: buildRatioPrices(model, record, groupRatio) }]
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export function MyPricing() {
  const { t, i18n } = useTranslation()
  const { models } = usePricingData()
  const { profile } = useProfile()
  const [records, setRecords] = useState<ModelDiscountRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState<Category>('all')
  const [keyword, setKeyword] = useState('')
  const [vendor, setVendor] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRecords(await getSelfModelDiscounts())
    } catch {
      /* 未登录/无配置时展示空状态 */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const exact = useMemo(() => {
    const map = new Map<string, ModelDiscountRecord>()
    for (const record of records) {
      if (record.model_name !== WILDCARD_MODEL) {
        map.set(record.model_name, record)
      }
    }
    return map
  }, [records])

  const wildcard = useMemo(
    () => records.find((r) => r.model_name === WILDCARD_MODEL),
    [records]
  )

  const rows = useMemo<RowData[]>(() => {
    const list: RowData[] = []
    for (const model of models) {
      const hit = exact.get(model.model_name)
      if (hit) {
        list.push({ model, discount: hit, matched: 'exact' })
      } else if (wildcard && !isNeutral(wildcard)) {
        list.push({ model, discount: wildcard, matched: 'wildcard' })
      }
    }
    return list
  }, [models, exact, wildcard])

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase()
    return rows.filter((row) => {
      if (category !== 'all' && categoryOf(row.model) !== category) return false
      if (vendor && (row.model.vendor_name || '') !== vendor) return false
      if (!key) return true
      return (
        row.model.model_name.toLowerCase().includes(key) ||
        (row.model.vendor_name || '').toLowerCase().includes(key)
      )
    })
  }, [rows, category, vendor, keyword])

  const vendors = useMemo(() => {
    const set = new Set<string>()
    rows.forEach((row) => set.add(row.model.vendor_name || t('其他')))
    return [...set].sort()
  }, [rows, t])

  const groups = useMemo(() => {
    const map = new Map<string, RowData[]>()
    for (const row of filtered) {
      const name = row.model.vendor_name || t('其他')
      const list = map.get(name) ?? []
      list.push(row)
      map.set(name, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered, t])

  const linesByModel = useMemo(() => {
    const map = new Map<string, LineData[]>()
    for (const row of filtered) {
      map.set(
        row.model.model_name,
        buildLines(
          row.model,
          row.discount,
          profile?.group ?? '',
          t as unknown as (
            key: string,
            options?: Record<string, unknown>
          ) => string,
          i18n.language
        )
      )
    }
    return map
  }, [filtered, profile?.group, t, i18n.language])

  const allLines = useMemo(
    () => [...linesByModel.values()].flat(),
    [linesByModel]
  )

  const showCreateCache = allLines.some((line) => line.prices.cacheCreate)
  const showImage = allLines.some((line) => line.prices.image)
  const showAudio = allLines.some((line) => line.prices.audio)

  return (
    <Main>
      <div className='min-h-0 flex-1 overflow-auto px-3 py-4 sm:px-5 sm:py-6'>
        <div className='mx-auto w-full max-w-[1400px] space-y-4'>
          <h1 className='text-2xl font-bold tracking-tight sm:text-3xl'>
            {t('我的定价')}
          </h1>

          <div className='flex flex-wrap items-center gap-x-6 gap-y-1 border-b'>
            {CATEGORY_TABS.map((tab) => (
              <button
                key={tab.key}
                type='button'
                onClick={() => setCategory(tab.key)}
                className={cn(
                  'relative -mb-px border-b-2 pb-2 text-sm transition-colors',
                  category === tab.key
                    ? 'border-primary text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                )}
              >
                {t(tab.label)}
              </button>
            ))}
          </div>

          <div className='flex flex-wrap items-center gap-2'>
            <div className='relative'>
              <Search className='text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2' />
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder={t('搜索模型名称')}
                className='bg-card focus:border-primary h-9 w-56 rounded-full border pr-3 pl-8 text-sm outline-none'
              />
            </div>
            <Combobox
              options={[
                { value: '', label: t('全部供应商') },
                ...vendors.map((v) => ({ value: v, label: v })),
              ]}
              value={vendor ?? ''}
              onValueChange={(v) => setVendor(v ? v : null)}
              placeholder={t('全部供应商')}
              className='h-9 w-44'
            />
            {wildcard && !isNeutral(wildcard) && (
              <span className='rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-600'>
                {t('全模型默认折扣')} {zheLabel(lowestRate(wildcard))}
              </span>
            )}
            <span className='text-muted-foreground text-xs'>
              {t('折后价按你的分组倍率与专属折扣计算，已直接作用于扣费')}
            </span>
          </div>

          {loading ? (
            <p className='text-muted-foreground py-16 text-center text-sm'>
              {t('加载中...')}
            </p>
          ) : groups.length === 0 ? (
            <div className='bg-card text-muted-foreground rounded-xl border py-20 text-center text-sm'>
              {rows.length === 0
                ? t('暂未设置专属折扣，当前按标准价计费。')
                : t('没有符合筛选条件的模型')}
            </div>
          ) : (
            <div className='space-y-4'>
              {groups.map(([vendorName, list]) => (
                <div
                  key={vendorName}
                  className='bg-card overflow-hidden rounded-xl border shadow-sm'
                >
                  <div className='bg-muted/40 border-b px-4 py-2'>
                    <span className='text-xs font-semibold tracking-wide uppercase'>
                      {vendorName}
                    </span>
                  </div>
                  <div className='overflow-x-auto'>
                    <table className='w-full text-sm'>
                      <thead>
                        <tr className='text-foreground border-b text-xs font-medium'>
                          <th className='px-4 py-3 text-left'>{t('模型')}</th>
                          <th className='px-4 py-3 text-right whitespace-nowrap'>
                            {t('输入')}
                            <div className='text-muted-foreground text-[11px] font-normal'>
                              {getCurrencyLabel()}/M Token
                            </div>
                          </th>
                          <th className='px-4 py-3 text-right whitespace-nowrap'>
                            {t('输出')}
                            <div className='text-muted-foreground text-[11px] font-normal'>
                              {getCurrencyLabel()}/M Token
                            </div>
                          </th>
                          <th className='px-4 py-3 text-right whitespace-nowrap'>
                            {t('输入（缓存命中）')}
                            <div className='text-muted-foreground text-[11px] font-normal'>
                              {getCurrencyLabel()}/M Token
                            </div>
                          </th>
                          {showCreateCache && (
                            <th className='px-4 py-3 text-right whitespace-nowrap'>
                              {t('显式缓存创建')}
                              <div className='text-muted-foreground text-[11px] font-normal'>
                                {getCurrencyLabel()}/M Token
                              </div>
                            </th>
                          )}
                          {showImage && (
                            <th className='px-4 py-3 text-right whitespace-nowrap'>
                              {t('图片')}
                              <div className='text-muted-foreground text-[11px] font-normal'>
                                {getCurrencyLabel()}/M Token
                              </div>
                            </th>
                          )}
                          {showAudio && (
                            <th className='px-4 py-3 text-right whitespace-nowrap'>
                              {t('音频')}
                              <div className='text-muted-foreground text-[11px] font-normal'>
                                {getCurrencyLabel()}/M Token
                              </div>
                            </th>
                          )}
                          <th className='px-4 py-3 text-right whitespace-nowrap'>
                            {t('按次')}
                            <div className='text-muted-foreground text-[11px] font-normal'>
                              {getCurrencyLabel()}/{t('次')}
                            </div>
                          </th>
                        </tr>
                      </thead>
                      <tbody className='divide-y'>
                        {list.flatMap((row) => {
                          const lines =
                            linesByModel.get(row.model.model_name) ?? []
                          return lines.map((line, index) => (
                            <tr
                              key={`${row.model.model_name}-${line.key}`}
                              className={cn(
                                'hover:bg-muted/25',
                                line.peak &&
                                  'bg-amber-500/10 hover:bg-amber-500/15'
                              )}
                            >
                              <td className='px-4 py-3 align-middle'>
                                {line.peak ? (
                                  <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
                                    <span className='rounded bg-amber-500/20 px-1.5 py-[1px] text-[11px] font-medium text-amber-700 dark:text-amber-400'>
                                      {t('高峰期')}
                                    </span>
                                    <span className='text-xs text-amber-700 dark:text-amber-400'>
                                      {line.condition}
                                    </span>
                                  </div>
                                ) : (
                                  <div className='min-w-0'>
                                    <div className='flex items-center gap-2'>
                                      <span
                                        className={cn(
                                          'truncate',
                                          index === 0
                                            ? 'text-sm font-semibold'
                                            : 'text-sm'
                                        )}
                                      >
                                        {row.model.model_name}
                                      </span>
                                    </div>
                                    {line.condition && (
                                      <p className='text-muted-foreground mt-0.5 truncate text-xs'>
                                        {t('适用条件')}：{line.condition}
                                      </p>
                                    )}
                                  </div>
                                )}
                              </td>
                              <td className='px-4 py-3 text-right'>
                                <PriceWithDiscount item={line.prices.input} />
                              </td>
                              <td className='px-4 py-3 text-right'>
                                <PriceWithDiscount item={line.prices.output} />
                              </td>
                              <td className='px-4 py-3 text-right'>
                                <PriceWithDiscount item={line.prices.cache} />
                              </td>
                              {showCreateCache && (
                                <td className='px-4 py-3 text-right'>
                                  <PriceWithDiscount
                                    item={line.prices.cacheCreate}
                                  />
                                </td>
                              )}
                              {showImage && (
                                <td className='px-4 py-3 text-right'>
                                  <PriceWithDiscount item={line.prices.image} />
                                </td>
                              )}
                              {showAudio && (
                                <td className='px-4 py-3 text-right'>
                                  <PriceWithDiscount item={line.prices.audio} />
                                </td>
                              )}
                              <td className='px-4 py-3 text-right'>
                                <PriceWithDiscount item={line.prices.fixed} />
                              </td>
                            </tr>
                          ))
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Main>
  )
}
