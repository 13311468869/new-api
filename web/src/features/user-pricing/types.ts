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
// 客户专属分项折扣（扩展）类型定义

export type DiscountItemKey =
  | 'discount_input'
  | 'discount_output'
  | 'discount_cache'
  | 'discount_image'
  | 'discount_audio'
  | 'discount_fixed'

export type ModelDiscountRecord = {
  id?: number
  user_id?: number
  model_name: string
  discount_input: number
  discount_output: number
  discount_cache: number
  discount_image: number
  discount_audio: number
  discount_fixed: number
  enabled?: boolean
  created_at?: number
  updated_at?: number
}

export const DISCOUNT_ITEMS: { key: DiscountItemKey; label: string }[] = [
  { key: 'discount_input', label: '输入' },
  { key: 'discount_output', label: '输出' },
  { key: 'discount_cache', label: '缓存' },
  { key: 'discount_image', label: '图片' },
  { key: 'discount_audio', label: '音频' },
  { key: 'discount_fixed', label: '按次' },
]

export const WILDCARD_MODEL = '*'
