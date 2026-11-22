package controller

import (
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/userpricing"

	"github.com/gin-gonic/gin"
)

// GetSelfModelDiscounts 返回当前登录用户的模型折扣配置（只读）。
func GetSelfModelDiscounts(c *gin.Context) {
	userId := c.GetInt("id")
	rows, err := userpricing.ListUserDiscounts(userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, rows)
}

// AdminGetUserModelDiscounts 管理员查看某个用户的模型折扣配置。
func AdminGetUserModelDiscounts(c *gin.Context) {
	userId, err := strconv.Atoi(c.Param("id"))
	if err != nil || userId <= 0 {
		common.ApiErrorMsg(c, "无效的用户 ID")
		return
	}
	if _, err := model.GetUserById(userId, false); err != nil {
		common.ApiError(c, err)
		return
	}
	rows, err := userpricing.ListUserDiscounts(userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, rows)
}

// AdminUpdateUserModelDiscounts 管理员整体覆盖某个用户的模型折扣配置。
// 请求体为 UserModelDiscount 数组，model_name 可传 "*" 表示全模型默认折扣，
// 折扣率取值 0-1（1 表示原价）；传空数组等于清空。
func AdminUpdateUserModelDiscounts(c *gin.Context) {
	userId, err := strconv.Atoi(c.Param("id"))
	if err != nil || userId <= 0 {
		common.ApiErrorMsg(c, "无效的用户 ID")
		return
	}
	if _, err := model.GetUserById(userId, false); err != nil {
		common.ApiError(c, err)
		return
	}
	var req []model.UserModelDiscount
	if err := c.ShouldBindJSON(&req); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := userpricing.SetUserDiscounts(userId, req); err != nil {
		common.ApiError(c, err)
		return
	}
	rows, err := userpricing.ListUserDiscounts(userId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, rows)
}
