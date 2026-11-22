package userpricing

import (
	"testing"

	"github.com/QuantumNous/new-api/pkg/billingexpr"
)

// evalQuota 求值并返回以「$/1M 系数单位」表示的原始输出。
func evalQuota(t *testing.T, exprStr string, params billingexpr.TokenParams) float64 {
	t.Helper()
	snap := &billingexpr.BillingSnapshot{
		ExprString:   exprStr,
		ExprHash:     billingexpr.ExprHashString(exprStr),
		GroupRatio:   1,
		QuotaPerUnit: 1_000_000,
		ExprVersion:  1,
	}
	result, err := billingexpr.ComputeTieredQuota(snap, params)
	if err != nil {
		t.Fatalf("eval %s: %v", exprStr, err)
	}
	return float64(result.ActualQuotaAfterGroup)
}

func TestDiscountedBillingExprScalesEachItem(t *testing.T) {
	const exprStr = `tier("base", p * 8 + c * 28 + cr * 2)`
	discounts := Discounts{Input: 0.5, Output: 0.8, Cache: 0.4, Image: 1, Audio: 1, Fixed: 1}

	rewritten, err := DiscountedBillingExpr(exprStr, discounts)
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	t.Logf("rewritten: %s", rewritten)

	got := evalQuota(t, rewritten, billingexpr.TokenParams{P: 72, C: 221, Len: 72})
	want := 72*8*0.5 + 221*28*0.8
	if diff := got - want; diff < -1 || diff > 1 {
		t.Fatalf("discounted cost = %v, want %v", got, want)
	}

	// 缓存项也要按 cache 折扣改写
	withCache := evalQuota(t, rewritten, billingexpr.TokenParams{CR: 1000})
	if want := 1000 * 2 * 0.4; withCache != want {
		t.Fatalf("cache term = %v, want %v", withCache, want)
	}
}

func TestDiscountedBillingExprKeepsTierConditions(t *testing.T) {
	const exprStr = `p > 1000000 ? tier("big", p * 8) : tier("small", p * 2)`
	rewritten, err := DiscountedBillingExpr(exprStr, Discounts{Input: 0.5, Output: 1, Cache: 1, Image: 1, Audio: 1, Fixed: 1})
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	t.Logf("rewritten: %s", rewritten)

	// 阈值必须保持 1000000，只有价格系数减半
	if big := evalQuota(t, rewritten, billingexpr.TokenParams{P: 2_000_000, Len: 2_000_000}); big != 2_000_000*4 {
		t.Fatalf("big tier = %v, want %v", big, 2_000_000*4)
	}
	if small := evalQuota(t, rewritten, billingexpr.TokenParams{P: 1000, Len: 1000}); small != 1000*1 {
		t.Fatalf("small tier = %v, want %v", small, 1000*1)
	}
}

func TestDiscountedBillingExprNeutralUnchanged(t *testing.T) {
	const exprStr = `tier("base", p * 8)`
	got, err := DiscountedBillingExpr(exprStr, NeutralDiscounts())
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if got != exprStr {
		t.Fatalf("neutral rewrite changed expr: %q", got)
	}
}

func TestDiscountedBillingExprFixedPrice(t *testing.T) {
	const exprStr = `tier("base", fixed(0.04))`
	original := evalQuota(t, exprStr, billingexpr.TokenParams{})
	rewritten, err := DiscountedBillingExpr(exprStr, Discounts{Input: 1, Output: 1, Cache: 1, Image: 1, Audio: 1, Fixed: 0.5})
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	t.Logf("rewritten: %s", rewritten)
	if got := evalQuota(t, rewritten, billingexpr.TokenParams{}); got != original*0.5 {
		t.Fatalf("fixed price = %v, want %v", got, original*0.5)
	}
}
