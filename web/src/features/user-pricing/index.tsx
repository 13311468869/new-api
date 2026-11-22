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

function categoryOf(model: PricingModel): Exclude<Category, 'all'> {
  const mods = new Set<string>([
    ...(model.input_modalities ?? []),
    ...(model.output_modalities ?? []),
  ])
  if (mods.has('video')) return 'video'
  if (mods.has('image')) {
    return model.quota_type === QUOTA_TYPE_VALUES.REQUEST ? 'image' : 'multimodal'
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

type PriceItem = { original: number; discounted: number; rate: number }

/** 折后价 + 绿色折扣标签 */
function PriceWithDiscount({ item }: { item?: PriceItem }) {
  if (!item || !Number.isFinite(item.discounted)) {
    return <span className='text-muted-foreground text-xs'>—</span>
  }
  return (
    <span
      className='inline-flex items-center justify-end gap-1.5'
      title={`${money(item.original)}`}
    >
      <span className='font-mono text-sm tabular-nums'>{money(item.discounted)}</span>
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

function buildPrices(
  model: PricingModel,
  record: ModelDiscountRecord,
  group: string
): PriceSet {
  const groupRatio = getConfiguredGroupRatio(model.group_ratio ?? {}, group)

  if (model.quota_type === QUOTA_TYPE_VALUES.REQUEST) {
    const original = (model.model_price ?? 0) * groupRatio
    return {
      fixed: {
        original,
        discounted: original * record.discount_fixed,
        rate: record.discount_fixed,
      },
    }
  }

  const base = (model.model_ratio ?? 0) * 2 * groupRatio
  const inputRate = record.discount_input
  const prices: PriceSet = {
    input: { original: base, discounted: base * inputRate, rate: inputRate },
  }

  if (Number.isFinite(model.completion_ratio)) {
    const ratio = Number(model.completion_ratio)
    prices.output = {
      original: base * ratio,
      discounted: base * inputRate * ratio * record.discount_output,
      rate: record.discount_output,
    }
  }

  const cacheRatio = model.cache_ratio == null ? NaN : Number(model.cache_ratio)
  if (Number.isFinite(cacheRatio)) {
    prices.cache = {
      original: base * cacheRatio,
      discounted: base * inputRate * cacheRatio * record.discount_cache,
      rate: record.discount_cache,
    }
  }

  const createRatio =
    model.create_cache_ratio == null ? NaN : Number(model.create_cache_ratio)
  if (Number.isFinite(createRatio)) {
    prices.cacheCreate = {
      original: base * createRatio,
      discounted: base * inputRate * createRatio * record.discount_cache,
      rate: record.discount_cache,
    }
  }

  const imageRatio = model.image_ratio == null ? NaN : Number(model.image_ratio)
  if (Number.isFinite(imageRatio)) {
    prices.image = {
      original: base * imageRatio,
      discounted: base * inputRate * imageRatio * record.discount_image,
      rate: record.discount_image,
    }
  }

  const audioRatio = model.audio_ratio == null ? NaN : Number(model.audio_ratio)
  if (Number.isFinite(audioRatio)) {
    prices.audio = {
      original: base * audioRatio,
      discounted: base * inputRate * audioRatio * record.discount_audio,
      rate: record.discount_audio,
    }
  }

  return prices
}

type RowData = {
  model: PricingModel
  discount: ModelDiscountRecord
  matched: 'exact' | 'wildcard'
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export function MyPricing() {
  const { t } = useTranslation()
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

  const showCreateCache = filtered.some(
    (row) => row.model.create_cache_ratio != null
  )
  const showImage = filtered.some((row) => row.model.image_ratio != null)
  const showAudio = filtered.some((row) => row.model.audio_ratio != null)

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
                        {list.map((row) => {
                          const prices = buildPrices(
                            row.model,
                            row.discount,
                            profile?.group ?? ''
                          )
                          return (
                            <tr
                              key={row.model.model_name}
                              className='hover:bg-muted/25'
                            >
                              <td className='px-4 py-4'>
                                <div className='min-w-0'>
                                  <p className='truncate text-sm font-semibold'>
                                    {row.model.model_name}
                                  </p>
                                  <p className='text-muted-foreground truncate text-xs'>
                                    {row.model.model_name}
                                  </p>
                                </div>
                              </td>
                              <td className='px-4 py-4 text-right'>
                                <PriceWithDiscount item={prices.input} />
                              </td>
                              <td className='px-4 py-4 text-right'>
                                <PriceWithDiscount item={prices.output} />
                              </td>
                              <td className='px-4 py-4 text-right'>
                                <PriceWithDiscount item={prices.cache} />
                              </td>
                              {showCreateCache && (
                                <td className='px-4 py-4 text-right'>
                                  <PriceWithDiscount item={prices.cacheCreate} />
                                </td>
                              )}
                              {showImage && (
                                <td className='px-4 py-4 text-right'>
                                  <PriceWithDiscount item={prices.image} />
                                </td>
                              )}
                              {showAudio && (
                                <td className='px-4 py-4 text-right'>
                                  <PriceWithDiscount item={prices.audio} />
                                </td>
                              )}
                              <td className='px-4 py-4 text-right'>
                                <PriceWithDiscount item={prices.fixed} />
                              </td>
                            </tr>
                          )
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
