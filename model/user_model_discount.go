package model

import (
	"errors"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

// 折扣作用到的计费项。每一项都是 0-1 的折扣率：
// 1 表示原价，0.8 表示 8 折，0 表示该项免费。
const (
	DiscountItemInput    = "input"    // 输入 token（模型基础倍率）
	DiscountItemOutput   = "output"   // 输出 token（补全倍率）
	DiscountItemCache    = "cache"    // 缓存命中与缓存写入
	DiscountItemImage    = "image"    // 图片 token
	DiscountItemAudio    = "audio"    // 音频 token
	DiscountItemFixed    = "fixed"    // 按次 / 任务固定价
	DiscountItemWildcard = "*"        // 模型名通配：该客户所有模型的默认折扣
)

// UserModelDiscount 客户在某个模型上的分项折扣配置。
// ModelName 支持传 "*"，表示该客户所有模型的默认折扣。
type UserModelDiscount struct {
	Id        int    `json:"id" gorm:"primaryKey;autoIncrement"`
	UserId    int    `json:"user_id" gorm:"not null;uniqueIndex:idx_user_model_discount"`
	ModelName string `json:"model_name" gorm:"type:varchar(255);not null;uniqueIndex:idx_user_model_discount"`

	DiscountInput  float64 `json:"discount_input" gorm:"type:double;not null;default:1"`
	DiscountOutput float64 `json:"discount_output" gorm:"type:double;not null;default:1"`
	DiscountCache  float64 `json:"discount_cache" gorm:"type:double;not null;default:1"`
	DiscountImage  float64 `json:"discount_image" gorm:"type:double;not null;default:1"`
	DiscountAudio  float64 `json:"discount_audio" gorm:"type:double;not null;default:1"`
	DiscountFixed  float64 `json:"discount_fixed" gorm:"type:double;not null;default:1"`

	Enabled   bool  `json:"enabled" gorm:"not null;default:true"`
	CreatedAt int64 `json:"created_at" gorm:"bigint"`
	UpdatedAt int64 `json:"updated_at" gorm:"bigint"`
}

func (UserModelDiscount) TableName() string {
	return "user_model_discounts"
}

// normalizeUserModelDiscount 规范一条折扣配置，返回可写入的副本。
func normalizeUserModelDiscount(userId int, row UserModelDiscount) (UserModelDiscount, error) {
	name := strings.TrimSpace(row.ModelName)
	if name == "" {
		return UserModelDiscount{}, errors.New("model name cannot be empty")
	}
	clamp := func(v float64) float64 {
		if v < 0 {
			return 0
		}
		if v > 1 {
			return 1
		}
		return v
	}
	row.UserId = userId
	row.ModelName = name
	row.DiscountInput = clamp(row.DiscountInput)
	row.DiscountOutput = clamp(row.DiscountOutput)
	row.DiscountCache = clamp(row.DiscountCache)
	row.DiscountImage = clamp(row.DiscountImage)
	row.DiscountAudio = clamp(row.DiscountAudio)
	row.DiscountFixed = clamp(row.DiscountFixed)
	return row, nil
}

func ListUserModelDiscounts(userId int) ([]UserModelDiscount, error) {
	var rows []UserModelDiscount
	err := DB.Where("user_id = ?", userId).Order("model_name ASC").Find(&rows).Error
	return rows, err
}

// ListEnabledUserModelDiscounts 返回全部启用中的折扣，供内存缓存加载。
func ListEnabledUserModelDiscounts() ([]UserModelDiscount, error) {
	var rows []UserModelDiscount
	err := DB.Where("enabled = ?", true).Find(&rows).Error
	return rows, err
}

// ReplaceUserModelDiscounts 用给定列表整体覆盖某个客户的折扣配置；
// 传空列表等于清空。折扣率会被规范到 [0, 1]。
func ReplaceUserModelDiscounts(userId int, rows []UserModelDiscount) error {
	if userId <= 0 {
		return errors.New("invalid user id")
	}
	normalized := make([]UserModelDiscount, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		item, err := normalizeUserModelDiscount(userId, row)
		if err != nil {
			return err
		}
		if _, ok := seen[item.ModelName]; ok {
			return errors.New("duplicated model name: " + item.ModelName)
		}
		seen[item.ModelName] = struct{}{}
		normalized = append(normalized, item)
	}

	now := common.GetTimestamp()
	return DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", userId).Delete(&UserModelDiscount{}).Error; err != nil {
			return err
		}
		if len(normalized) == 0 {
			return nil
		}
		for i := range normalized {
			normalized[i].Enabled = true
			normalized[i].CreatedAt = now
			normalized[i].UpdatedAt = now
		}
		return tx.Create(&normalized).Error
	})
}
