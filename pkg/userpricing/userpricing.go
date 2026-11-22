// Package userpricing 管理「客户专属分项折扣」的读取与缓存。
//
// 设计目标：官方核心代码只留极少接入点，其余逻辑集中在这里。
// 计费链路通过 GetDiscounts(userId, modelName) 拿到某个客户在某个模型上的
// 分项折扣，再由调用方乘到对应的倍率上（输入/输出/缓存/图片/音频/按次）。
package userpricing

import (
	"sync"
	"time"

	"github.com/QuantumNous/new-api/model"
)

// Discounts 是某个客户在某个模型上的分项折扣率，1 表示原价。
type Discounts struct {
	Input  float64
	Output float64
	Cache  float64
	Image  float64
	Audio  float64
	Fixed  float64
}

// NeutralDiscounts 表示完全不打折。
func NeutralDiscounts() Discounts {
	return Discounts{Input: 1, Output: 1, Cache: 1, Image: 1, Audio: 1, Fixed: 1}
}

// IsNeutral 判断是否所有计费项都不打折，调用方可据此完全跳过折扣计算。
func (d Discounts) IsNeutral() bool {
	return d.Input == 1 && d.Output == 1 && d.Cache == 1 && d.Image == 1 && d.Audio == 1 && d.Fixed == 1
}

const cacheTTL = 60 * time.Second

var (
	mu       sync.RWMutex
	byUser   = map[int]map[string]Discounts{}
	loadedAt time.Time
	reloadMu sync.Mutex
)

// Reload 从数据库重新加载全部启用中的折扣。
func Reload() error {
	rows, err := model.ListEnabledUserModelDiscounts()
	if err != nil {
		return err
	}
	built := make(map[int]map[string]Discounts, len(rows))
	for _, row := range rows {
		models, ok := built[row.UserId]
		if !ok {
			models = map[string]Discounts{}
			built[row.UserId] = models
		}
		models[row.ModelName] = Discounts{
			Input:  row.DiscountInput,
			Output: row.DiscountOutput,
			Cache:  row.DiscountCache,
			Image:  row.DiscountImage,
			Audio:  row.DiscountAudio,
			Fixed:  row.DiscountFixed,
		}
	}

	mu.Lock()
	byUser = built
	loadedAt = time.Now()
	mu.Unlock()
	return nil
}

func loaded() map[int]map[string]Discounts {
	mu.RLock()
	defer mu.RUnlock()
	return byUser
}

func stale() bool {
	mu.RLock()
	defer mu.RUnlock()
	return time.Since(loadedAt) > cacheTTL
}

// ensureFresh 在缓存过期时刷新；并发请求只会有一次真正落库。
func ensureFresh() {
	if !stale() {
		return
	}
	reloadMu.Lock()
	defer reloadMu.Unlock()
	if !stale() {
		return
	}
	_ = Reload()
}

// GetDiscounts 返回客户在指定模型上的分项折扣。
// 精确匹配优先，其次使用该客户的 "*" 通配配置，都没有则返回原价。
func GetDiscounts(userId int, modelName string) Discounts {
	if userId <= 0 {
		return NeutralDiscounts()
	}
	ensureFresh()
	snapshot := loaded()

	models, ok := snapshot[userId]
	if !ok {
		return NeutralDiscounts()
	}
	if d, ok := models[modelName]; ok {
		return d
	}
	if d, ok := models[model.DiscountItemWildcard]; ok {
		return d
	}
	return NeutralDiscounts()
}

// SetUserDiscounts 覆盖写入某客户的折扣配置并立即刷新缓存。
func SetUserDiscounts(userId int, rows []model.UserModelDiscount) error {
	if err := model.ReplaceUserModelDiscounts(userId, rows); err != nil {
		return err
	}
	return Reload()
}

// ListUserDiscounts 返回某客户的原始折扣配置（含未生效项，供管理端编辑）。
func ListUserDiscounts(userId int) ([]model.UserModelDiscount, error) {
	return model.ListUserModelDiscounts(userId)
}

// Normalized 把零值结构体视为原价，避免调用方忘记赋值时误判为全免费。
func (d Discounts) Normalized() Discounts {
	if d.Input == 0 && d.Output == 0 && d.Cache == 0 && d.Image == 0 && d.Audio == 0 && d.Fixed == 0 {
		return NeutralDiscounts()
	}
	return d
}

// EffectiveForModel 返回把折扣应用到给定「分项倍率」后的结果，便于前端/日志展示。
func (d Discounts) ApplyInput(ratio float64) float64  { return ratio * d.Input }
func (d Discounts) ApplyOutput(ratio float64) float64 { return ratio * d.Output }
func (d Discounts) ApplyCache(ratio float64) float64  { return ratio * d.Cache }
func (d Discounts) ApplyImage(ratio float64) float64  { return ratio * d.Image }
func (d Discounts) ApplyAudio(ratio float64) float64  { return ratio * d.Audio }
func (d Discounts) ApplyFixed(price float64) float64  { return price * d.Fixed }
