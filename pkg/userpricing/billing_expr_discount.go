// 本文件实现「把客户分项折扣按计费项改写进 billing_expr 表达式」。
//
// 背景：tiered_expr（动态计费）模型的单价写在表达式系数里，如
//   tier("base", p * 8 + c * 28 + cr * 2)
// 这样一个表达式无法像倍率模型那样按项乘折扣。这里在求值前把每个变量前的
// 数字系数按对应计费项折一次，得到等价的「折后表达式」：
//   tier("base", p * 4 + c * 14 + cr * 2)
// 预扣、结算、日志展示都用这条折后表达式，金额与展示口径自然一致。
package userpricing

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"

	"github.com/expr-lang/expr/ast"
	"github.com/expr-lang/expr/parser"
)

// exprDiscountCacheLimit 限制折后表达式的缓存条数，避免模型/折扣组合无限增长。
const exprDiscountCacheLimit = 512

var (
	exprDiscountMu    sync.RWMutex
	exprDiscountCache = map[string]string{}
)

// priceVarDiscountKind 把表达式变量归类到计费项。
type discountKind int

const (
	kindInput discountKind = iota
	kindOutput
	kindCache
	kindImage
	kindAudio
	kindFixed
)

var priceVarKinds = map[string]discountKind{
	"p":           kindInput,
	"len":         kindInput,
	"c":           kindOutput,
	"cr":          kindCache,
	"cc":          kindCache,
	"cc1h":        kindCache,
	"cc12h":       kindCache,
	"img":         kindImage,
	"img_cr":      kindImage,
	"img_o":       kindImage,
	"image_count": kindImage,
	"ai":          kindAudio,
	"ao":          kindAudio,
}

func (d Discounts) rateFor(kind discountKind) float64 {
	switch kind {
	case kindInput:
		return d.Input
	case kindOutput:
		return d.Output
	case kindCache:
		return d.Cache
	case kindImage:
		return d.Image
	case kindAudio:
		return d.Audio
	default:
		return d.Fixed
	}
}

func (d Discounts) cacheKey() string {
	return strings.Join([]string{
		formatRate(d.Input),
		formatRate(d.Output),
		formatRate(d.Cache),
		formatRate(d.Image),
		formatRate(d.Audio),
		formatRate(d.Fixed),
	}, "/")
}

func formatRate(rate float64) string {
	return strconv.FormatFloat(rate, 'f', -1, 64)
}

// coefficientPatcher 把「变量 × 数字」里的数字按该变量的计费项打折。
//
// 只改写乘法里与计价变量直接相邻的数字常量，因此条件表达式（如
// p > 1000000）里的阈值不会被改动，阶梯选择逻辑保持不变。
type coefficientPatcher struct {
	discounts Discounts
	changed   bool
}

func (p *coefficientPatcher) Visit(node *ast.Node) {
	switch n := (*node).(type) {
	case *ast.BinaryNode:
		if n.Operator != "*" {
			return
		}
		var kind discountKind
		var kindOK bool
		var coefficientSlot *ast.Node
		switch {
		case n.Left != nil && n.Right != nil:
			if id, ok := n.Left.(*ast.IdentifierNode); ok {
				kind, kindOK = priceVarKinds[id.Value]
				coefficientSlot = &n.Right
			} else if id, ok := n.Right.(*ast.IdentifierNode); ok {
				kind, kindOK = priceVarKinds[id.Value]
				coefficientSlot = &n.Left
			} else {
				// 任务计费用量项：u("seconds") * 0.17，按「按次」项打折
				if call, ok := n.Left.(*ast.CallNode); ok && isUsageCall(call) {
					kind, kindOK = kindFixed, true
					coefficientSlot = &n.Right
				} else if call, ok := n.Right.(*ast.CallNode); ok && isUsageCall(call) {
					kind, kindOK = kindFixed, true
					coefficientSlot = &n.Left
				}
			}
		}
		if !kindOK || coefficientSlot == nil {
			return
		}
		p.scale(coefficientSlot, p.discounts.rateFor(kind))

	case *ast.CallNode:
		// fixed(0.04) 这类固定单价的字面量参数
		if id, ok := n.Callee.(*ast.IdentifierNode); !ok || id.Value != "fixed" {
			return
		}
		if len(n.Arguments) != 1 {
			return
		}
		p.scale(&n.Arguments[0], p.discounts.Fixed)
	}
}

func (p *coefficientPatcher) scale(slot *ast.Node, rate float64) {
	if rate == 1 || slot == nil {
		return
	}
	switch value := (*slot).(type) {
	case *ast.IntegerNode:
		ast.Patch(slot, &ast.FloatNode{Value: roundPrice(float64(value.Value) * rate)})
		p.changed = true
	case *ast.FloatNode:
		if value.Value == 0 {
			return
		}
		ast.Patch(slot, &ast.FloatNode{Value: roundPrice(value.Value * rate)})
		p.changed = true
	}
}

// roundPrice 把折后系数按 6 位小数收敛，避免 22.400000000000002 之类的浮点噪声
// 出现在日志与账单展示里。
func roundPrice(value float64) float64 {
	return math.Round(value*1e6) / 1e6
}

func isUsageCall(call *ast.CallNode) bool {
	id, ok := call.Callee.(*ast.IdentifierNode)
	return ok && id.Value == "u"
}

// DiscountedBillingExpr 返回按分项折扣改写后的表达式。
// 折扣全为原价时原样返回；解析失败时返回错误，由调用方回退到原表达式。
func DiscountedBillingExpr(exprStr string, d Discounts) (string, error) {
	d = d.Normalized()
	if d.IsNeutral() || exprStr == "" {
		return exprStr, nil
	}

	key := d.cacheKey() + "|" + exprStr
	exprDiscountMu.RLock()
	if cached, ok := exprDiscountCache[key]; ok {
		exprDiscountMu.RUnlock()
		return cached, nil
	}
	exprDiscountMu.RUnlock()

	prefix, body := splitExprVersion(exprStr)
	tree, err := parser.Parse(body)
	if err != nil {
		return exprStr, fmt.Errorf("parse billing expr for discount: %w", err)
	}
	patcher := &coefficientPatcher{discounts: d}
	root := tree.Node
	ast.Walk(&root, patcher)

	rewritten := exprStr
	if patcher.changed {
		rewritten = prefix + root.String()
	}

	exprDiscountMu.Lock()
	if len(exprDiscountCache) >= exprDiscountCacheLimit {
		exprDiscountCache = make(map[string]string, exprDiscountCacheLimit)
	}
	exprDiscountCache[key] = rewritten
	exprDiscountMu.Unlock()

	return rewritten, nil
}

// splitExprVersion 保留 "v1:" 之类的前缀，只对表达式主体做改写。
func splitExprVersion(exprStr string) (prefix, body string) {
	if i := strings.Index(exprStr, ":"); i > 0 && len(exprStr) > i+1 {
		candidate := exprStr[:i]
		if len(candidate) <= 8 && strings.HasPrefix(candidate, "v") {
			return exprStr[:i+1], exprStr[i+1:]
		}
	}
	return "", exprStr
}
