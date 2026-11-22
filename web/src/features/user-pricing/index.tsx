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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { StaticDataTable } from '@/components/data-table'
import { SectionPageLayout } from '@/components/layout'
import { QUOTA_TYPE_VALUES } from '@/features/pricing/constants'
import { usePricingData } from '@/features/pricing/hooks/use-pricing-data'
import { getConfiguredGroupRatio } from '@/features/pricing/lib/model-helpers'
import type { PricingModel } from '@/features/pricing/types'
import { useProfile } from '@/features/profile/hooks'
import { formatBillingCurrencyFromUSD } from '@/lib/currency'

import { getSelfModelDiscounts } from './api'
import { DISCOUNT_ITEMS, WILDCARD_MODEL } from './types'
import type { ModelDiscountRecord } from './types'

function formatPercent(value: number): string {
  const pct = (Number.isFinite(value) ? value : 1) * 100
  return `${Math.round(pct * 100) / 100}%`
}

function closestModel(
  models: PricingModel[],
  modelName: string
): PricingModel | undefined {
  if (!modelName || modelName === WILDCARD_MODEL) return undefined
  return models.find((m) => m.model_name === modelName)
}

type Row = {
  record: ModelDiscountRecord
  model?: PricingModel
  priceLine: string
}

function DiscountCell({ value }: { value: number }) {
  const effective = Number.isFinite(value) ? value : 1
  const className =
    effective >= 1
      ? 'text-muted-foreground'
      : effective <= 0
        ? 'font-medium text-emerald-600'
        : 'font-medium text-amber-600'
  return <span className={className}>{formatPercent(effective)}</span>
}

export function MyPricing() {
  const { t } = useTranslation()
  const { models } = usePricingData()
  const { profile } = useProfile()
  const [records, setRecords] = useState<ModelDiscountRecord[]>([])
  const [loading, setLoading] = useState(true)

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

  const rows = useMemo<Row[]>(() => {
    return records.map((record) => {
      const model = closestModel(models, record.model_name)
      let priceLine = '-'
      if (model) {
        const groupRatio = getConfiguredGroupRatio(
          model.group_ratio ?? {},
          profile?.group ?? ''
        )
        if (model.quota_type === QUOTA_TYPE_VALUES.REQUEST) {
          const price =
            (model.model_price ?? 0) * groupRatio * record.discount_fixed
          priceLine = `${t('每次')} ${formatBillingCurrencyFromUSD(price, {
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
          })} / 1M`
        }
      }
      return { record, model, priceLine }
    })
  }, [records, models, profile?.group, t])

  const hasWildcard = records.some((r) => r.model_name === WILDCARD_MODEL)

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('我的定价')}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className='mx-auto flex w-full max-w-5xl flex-col gap-3'>
          <p className='text-muted-foreground text-xs sm:text-sm'>
            {t(
              '这里只展示你账号专属的模型折扣，其他客户看不到。折扣由管理员设置，直接体现在扣费中；100% 表示原价。'
            )}
            {hasWildcard &&
              ` ${t('标注 * 的行是你所有模型的默认折扣，没有单独配置的模型按它计价。')}`}
          </p>

          <StaticDataTable<Row>
            data={loading ? [] : rows}
            getRowKey={(row) => row.record.model_name}
            empty={loading}
            emptyContent={
              loading ? t('加载中...') : t('暂未设置专属折扣，当前按标准价计费。')
            }
            columns={[
              {
                id: 'model',
                header: t('模型'),
                cell: (row) => (
                  <div className='min-w-0'>
                    <p className='truncate font-mono text-sm'>
                      {row.record.model_name === WILDCARD_MODEL
                        ? '* (全部模型默认)'
                        : row.record.model_name}
                    </p>
                    {row.model?.vendor_name && (
                      <p className='text-muted-foreground truncate text-xs'>
                        {row.model.vendor_name}
                      </p>
                    )}
                  </div>
                ),
              },
              ...DISCOUNT_ITEMS.map((item) => ({
                id: item.key,
                header: t(item.label),
                className: 'text-right whitespace-nowrap',
                cellClassName: 'text-right whitespace-nowrap',
                cell: (row: Row) => (
                  <DiscountCell value={Number(row.record[item.key] ?? 1)} />
                ),
              })),
              {
                id: 'price',
                header: t('折后价格'),
                className: 'text-right whitespace-nowrap',
                cellClassName: 'text-right whitespace-nowrap',
                cell: (row) => (
                  <span className='text-muted-foreground text-xs'>
                    {row.priceLine}
                  </span>
                ),
              },
            ]}
          />
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
