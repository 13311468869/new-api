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
import { Tags } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { IconBadge } from '@/components/ui/icon-badge'
import { QUOTA_TYPE_VALUES } from '@/features/pricing/constants'
import { getConfiguredGroupRatio } from '@/features/pricing/lib/model-helpers'
import { usePricingData } from '@/features/pricing/hooks/use-pricing-data'
import type { PricingModel } from '@/features/pricing/types'
import { formatBillingCurrencyFromUSD } from '@/lib/currency'

import { getSelfModelDiscounts } from '../api'
import { DISCOUNT_ITEMS, WILDCARD_MODEL } from '../types'
import type { ModelDiscountRecord } from '../types'

interface Props {
  group?: string
}

function formatPercent(value: number): string {
  const pct = (Number.isFinite(value) ? value : 1) * 100
  const rounded = Math.round(pct * 100) / 100
  return `${rounded}%`
}

function discountTone(value: number): string {
  if (!Number.isFinite(value) || value >= 1) {
    return 'text-muted-foreground border-border/60'
  }
  if (value <= 0) {
    return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
  }
  return 'border-amber-500/40 bg-amber-500/10 text-amber-600'
}

function closestModel(
  models: PricingModel[],
  modelName: string
): PricingModel | undefined {
  if (!modelName || modelName === WILDCARD_MODEL) return undefined
  return models.find((m) => m.model_name === modelName)
}

export function MyPricingCard({ group }: Props) {
  const { t } = useTranslation()
  const { models } = usePricingData()
  const [records, setRecords] = useState<ModelDiscountRecord[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getSelfModelDiscounts()
      setRecords(data)
    } catch {
      /* 无配置时静默展示空状态 */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const rows = useMemo(() => {
    return records.map((record) => {
      const model = closestModel(models, record.model_name)
      let priceLine: string | null = null
      if (model) {
        const groupRatio = getConfiguredGroupRatio(
          model.group_ratio ?? {},
          group ?? ''
        )
        if (model.quota_type === QUOTA_TYPE_VALUES.REQUEST) {
          const price =
            (model.model_price ?? 0) * groupRatio * record.discount_fixed
          priceLine = `${t('按次')} ${formatBillingCurrencyFromUSD(price, {
            digitsLarge: 4,
            digitsSmall: 4,
            abbreviate: false,
          })}`
        } else {
          const base = (model.model_ratio ?? 0) * 2 * groupRatio
          const inputPrice = base * record.discount_input
          const outputPrice =
            base *
            record.discount_input *
            (model.completion_ratio ?? 1) *
            record.discount_output
          priceLine = `${t('输入')} ${formatBillingCurrencyFromUSD(inputPrice, {
            digitsLarge: 4,
            digitsSmall: 6,
            abbreviate: false,
          })} · ${t('输出')} ${formatBillingCurrencyFromUSD(outputPrice, {
            digitsLarge: 4,
            digitsSmall: 6,
            abbreviate: false,
          })} / 1M tokens`
        }
      }
      return { record, model, priceLine }
    })
  }, [records, models, group, t])

  const hasWildcard = rows.some(
    (row) => row.record.model_name === WILDCARD_MODEL
  )

  return (
    <Card data-card-hover='false' className='gap-0 overflow-hidden py-0'>
      <CardHeader className='border-b p-3 !pb-3 sm:p-5 sm:!pb-5'>
        <div className='flex items-center gap-3'>
          <IconBadge tone='success' size='title'>
            <Tags />
          </IconBadge>
          <div className='min-w-0'>
            <CardTitle className='text-lg tracking-tight sm:text-xl'>
              {t('我的定价')}
            </CardTitle>
            <CardDescription className='text-xs sm:text-sm'>
              {t('你专属的模型折扣，仅你自己可见')}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-3 p-3 sm:p-5'>
        {loading ? (
          <p className='text-muted-foreground text-sm'>{t('加载中...')}</p>
        ) : rows.length === 0 ? (
          <p className='text-muted-foreground text-sm'>
            {t('暂未设置专属折扣，当前按标准价计费。')}
          </p>
        ) : (
          <>
            {hasWildcard && (
              <p className='text-muted-foreground text-xs'>
                {t('标有 * 的行是该客户所有模型的默认折扣。')}
              </p>
            )}
            <div className='divide-y'>
              {rows.map((row) => (
                <div key={row.record.model_name} className='space-y-2 py-3'>
                  <div className='flex items-center justify-between gap-2'>
                    <p className='truncate font-mono text-sm font-medium'>
                      {row.record.model_name === WILDCARD_MODEL
                        ? t('全部模型（默认）')
                        : row.record.model_name}
                    </p>
                    {row.priceLine && (
                      <p className='text-muted-foreground text-right text-xs'>
                        {row.priceLine}
                      </p>
                    )}
                  </div>
                  <div className='flex flex-wrap gap-1.5'>
                    {DISCOUNT_ITEMS.map((item) => {
                      const value = Number(row.record[item.key] ?? 1)
                      return (
                        <span
                          key={item.key}
                          className={`rounded-md border px-2 py-0.5 text-[11px] ${discountTone(
                            value
                          )}`}
                        >
                          {t(item.label)} {formatPercent(value)}
                        </span>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
            <p className='text-muted-foreground border-t pt-3 text-xs'>
              {t('折扣由管理员设置；100% 表示原价，折扣会直接体现在扣费中。')}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
