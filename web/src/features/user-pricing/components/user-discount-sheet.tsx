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
import { Plus, Save, Star, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  sideDrawerContentClassName,
  sideDrawerFormClassName,
  sideDrawerHeaderClassName,
} from '@/components/drawer-layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { handleServerError } from '@/lib/handle-server-error'

import { adminGetUserModelDiscounts, adminUpdateUserModelDiscounts } from '../api'
import { DISCOUNT_ITEMS, WILDCARD_MODEL } from '../types'
import type { DiscountItemKey, ModelDiscountRecord } from '../types'

type EditableRow = {
  key: string
  model_name: string
  discount_input: number
  discount_output: number
  discount_cache: number
  discount_image: number
  discount_audio: number
  discount_fixed: number
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  user: { id: number; username?: string } | null
  onSuccess?: () => void
}

let rowSeed = 0
function nextKey() {
  rowSeed += 1
  return `row-${rowSeed}`
}

function toEditable(record: ModelDiscountRecord): EditableRow {
  const percent = (v: number | undefined) =>
    Math.round((Number.isFinite(v as number) ? (v as number) : 1) * 10000) / 100
  return {
    key: nextKey(),
    model_name: record.model_name,
    discount_input: percent(record.discount_input),
    discount_output: percent(record.discount_output),
    discount_cache: percent(record.discount_cache),
    discount_image: percent(record.discount_image),
    discount_audio: percent(record.discount_audio),
    discount_fixed: percent(record.discount_fixed),
  }
}

function emptyRow(modelName = ''): EditableRow {
  return {
    key: nextKey(),
    model_name: modelName,
    discount_input: 100,
    discount_output: 100,
    discount_cache: 100,
    discount_image: 100,
    discount_audio: 100,
    discount_fixed: 100,
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 100
  return Math.min(100, Math.max(0, value))
}

export function UserDiscountSheet(props: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<EditableRow[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!props.user?.id) return
    setLoading(true)
    try {
      const data = await adminGetUserModelDiscounts(props.user.id)
      setRows(data.map(toEditable))
    } catch (error) {
      handleServerError(error, t('加载折扣配置失败'))
    } finally {
      setLoading(false)
    }
  }, [props.user?.id, t])

  useEffect(() => {
    if (props.open) {
      load()
    } else {
      setRows([])
    }
  }, [props.open, load])

  const updateRow = (key: string, patch: Partial<EditableRow>) => {
    setRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, ...patch } : row))
    )
  }

  const handleSave = async () => {
    if (!props.user?.id) return
    const seen = new Set<string>()
    for (const row of rows) {
      const name = row.model_name.trim()
      if (!name) {
        toast.error(t('模型名不能为空'))
        return
      }
      if (seen.has(name)) {
        toast.error(t('模型名重复：{{name}}', { name }))
        return
      }
      seen.add(name)
    }
    setSaving(true)
    try {
      const payload: ModelDiscountRecord[] = rows.map((row) => ({
        model_name: row.model_name.trim(),
        discount_input: clampPercent(row.discount_input) / 100,
        discount_output: clampPercent(row.discount_output) / 100,
        discount_cache: clampPercent(row.discount_cache) / 100,
        discount_image: clampPercent(row.discount_image) / 100,
        discount_audio: clampPercent(row.discount_audio) / 100,
        discount_fixed: clampPercent(row.discount_fixed) / 100,
      }))
      const data = await adminUpdateUserModelDiscounts(props.user.id, payload)
      setRows(data.map(toEditable))
      toast.success(t('折扣配置已保存'))
      props.onSuccess?.()
    } catch (error) {
      handleServerError(error, t('保存折扣配置失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent className={sideDrawerContentClassName('sm:max-w-3xl')}>
        <SheetHeader className={sideDrawerHeaderClassName()}>
          <SheetTitle>{t('客户定价设置')}</SheetTitle>
          <SheetDescription>
            {props.user?.username || '-'} (ID: {props.user?.id || '-'}) ·{' '}
            {t('折扣按计费项分别设置，100% 表示原价')}
          </SheetDescription>
        </SheetHeader>

        <div className={sideDrawerFormClassName()}>
          <div className='flex flex-wrap gap-2'>
            <Button
              variant='outline'
              onClick={() => setRows((prev) => [...prev, emptyRow()])}
            >
              <Plus className='mr-1 h-4 w-4' />
              {t('添加模型')}
            </Button>
            <Button
              variant='outline'
              onClick={() => setRows((prev) => [...prev, emptyRow(WILDCARD_MODEL)])}
              disabled={rows.some((row) => row.model_name === WILDCARD_MODEL)}
            >
              <Star className='mr-1 h-4 w-4' />
              {t('添加全模型默认行 (*)')}
            </Button>
            <Button onClick={handleSave} disabled={saving || loading}>
              <Save className='mr-1 h-4 w-4' />
              {saving ? t('保存中...') : t('保存')}
            </Button>
          </div>

          {loading ? (
            <p className='text-muted-foreground text-sm'>{t('加载中...')}</p>
          ) : rows.length === 0 ? (
            <p className='text-muted-foreground text-sm'>
              {t('该客户暂无专属折扣，按标准价计费。')}
            </p>
          ) : (
            <div className='space-y-3'>
              {rows.map((row) => (
                <div key={row.key} className='bg-background/60 rounded-xl border p-3'>
                  <div className='flex items-center gap-2'>
                    <Input
                      value={row.model_name}
                      onChange={(e) =>
                        updateRow(row.key, { model_name: e.target.value })
                      }
                      placeholder={t('模型名，例如 gpt-4o；* 表示全部模型')}
                      className='flex-1 font-mono'
                    />
                    <Button
                      variant='ghost'
                      size='icon'
                      aria-label={t('删除')}
                      onClick={() =>
                        setRows((prev) => prev.filter((r) => r.key !== row.key))
                      }
                    >
                      <Trash2 className='text-destructive h-4 w-4' />
                    </Button>
                  </div>
                  <div className='mt-1 text-muted-foreground text-xs'>
                    {row.model_name === WILDCARD_MODEL
                      ? t('该客户所有模型的默认折扣')
                      : t('仅对该模型生效的折扣')}
                  </div>
                  <div className='mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3'>
                    {DISCOUNT_ITEMS.map((item) => (
                      <label key={item.key} className='space-y-1'>
                        <span className='text-muted-foreground text-xs'>
                          {t(item.label)} {t('折扣')} (%)
                        </span>
                        <Input
                          type='number'
                          min={0}
                          max={100}
                          step={1}
                          value={row[item.key as DiscountItemKey]}
                          onChange={(e) =>
                            updateRow(row.key, {
                              [item.key]: Number(e.target.value),
                            } as Partial<EditableRow>)
                          }
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className='text-muted-foreground border-t pt-3 text-xs'>
            {t(
              '提示：输入/输出/缓存/图片/音频分别作用于对应 token 计费项，按次作用于固定价任务；保存后立即影响预扣与实际结算。'
            )}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  )
}
