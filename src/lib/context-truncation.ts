/**
 * Context Truncation Module
 * 上下文截断模块 - 移植自 gcli2api/src/context_truncation.py
 *
 * 功能：
 * - 智能截断消息列表以适应模型 token 限制
 * - 保留系统消息和工具上下文
 * - 压缩过大的工具结果
 */

import consola from "consola"

import type { Message } from "~/services/copilot/create-chat-completions"

// 模型上下文限制配置
// 参考: https://platform.openai.com/docs/models
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
	// GPT-4 系列
	"gpt-4": 8192,
	"gpt-4-32k": 32768,
	"gpt-4-turbo": 128000,
	"gpt-4-turbo-preview": 128000,
	"gpt-4o": 128000,
	"gpt-4o-mini": 128000,
	"gpt-4.1": 1000000, // 新版本可能有更大上下文
	"gpt-4.1-mini": 1000000,
	"gpt-4.5-preview": 128000,
	// GPT-5 系列 (Copilot 新模型)
	"gpt-5": 128000,
	"gpt-5.2": 128000,
	"gpt-5.2-codex": 128000,
	// o 系列推理模型
	"o1": 200000,
	"o1-mini": 128000,
	"o1-preview": 128000,
	"o1-pro": 200000,
	"o3": 200000,
	"o3-mini": 128000,
	"o3-pro": 200000,
	"o4-mini": 200000,
	// Claude 系列
	"claude-3-opus": 200000,
	"claude-3-sonnet": 200000,
	"claude-3-haiku": 200000,
	"claude-3.5-sonnet": 200000,
	"claude-3.5-haiku": 200000,
	"claude-sonnet-4": 200000,
	"claude-opus-4": 200000,
	"claude-haiku-4": 200000,
	// Gemini 系列
	"gemini-2.0-flash": 1000000,
	"gemini-2.5-pro": 1000000,
	// 默认值
	default: 128000,
}

// 消息分类类型
type MessageCategory = "system" | "tool_context" | "regular"

// 截断结果接口
interface TruncationResult {
	messages: Message[]
	originalTokens: number
	truncatedTokens: number
	removedCount: number
	compressedCount: number
}

/**
 * 获取模型的上下文限制
 */
function getModelContextLimit(model: string): number {
	// 首先尝试精确匹配
	if (model in MODEL_CONTEXT_LIMITS) {
		return MODEL_CONTEXT_LIMITS[model]
	}

	// 尝试前缀匹配
	for (const [prefix, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
		if (prefix !== "default" && model.startsWith(prefix)) {
			return limit
		}
	}

	// 基于模型名称的模式匹配
	if (model.includes("claude")) {
		return 200000
	}
	if (model.includes("gemini")) {
		return 1000000
	}
	if (model.includes("gpt-4")) {
		return 128000
	}
	if (model.includes("gpt-5")) {
		return 128000
	}
	if (model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) {
		return 200000
	}

	return MODEL_CONTEXT_LIMITS.default
}

/**
 * 获取动态目标 token 限制
 * 预留一定比例给模型输出
 */
function getDynamicTargetLimit(model: string, reserveRatio = 0.15): number {
	const contextLimit = getModelContextLimit(model)
	// 预留 15% 给输出，最少预留 4096 tokens
	const reserved = Math.max(Math.floor(contextLimit * reserveRatio), 4096)
	return contextLimit - reserved
}

/**
 * 分类消息
 */
function categorizeMessage(message: Message): MessageCategory {
	// 系统消息始终保留
	if (message.role === "system") {
		return "system"
	}

	// 工具调用和工具结果属于工具上下文
	if (message.role === "tool") {
		return "tool_context"
	}

	if (message.role === "assistant") {
		if (message.tool_calls && message.tool_calls.length > 0) {
			return "tool_context"
		}
	}

	return "regular"
}

/**
 * 估算消息的 token 数量
 * 使用简单的字符估算方法，平均每 4 个字符约 1 token
 */
function estimateMessageTokens(message: Message): number {
	let text = ""

	if (typeof message.content === "string") {
		text = message.content
	} else if (Array.isArray(message.content)) {
		// 处理多模态内容
		for (const part of message.content) {
			if ("text" in part && typeof part.text === "string") {
				text += part.text
			} else if ("image_url" in part) {
				// 图片大约消耗 85-170 tokens，取中间值
				text += " ".repeat(128 * 4) // 128 tokens worth
			}
		}
	}

	// 添加工具调用的内容
	if (message.role === "assistant" && message.tool_calls) {
		for (const toolCall of message.tool_calls) {
			text += toolCall.function?.name || ""
			text += toolCall.function?.arguments || ""
		}
	}

	// 添加 tool 消息的内容
	if (message.role === "tool" && message.tool_call_id) {
		text += message.tool_call_id
	}

	// 简单估算：平均每 4 个字符约 1 token，加上消息格式开销
	return Math.ceil(text.length / 4) + 4
}

/**
 * 压缩工具结果
 * 对于过大的工具结果，进行智能压缩
 */
function compressToolResult(message: Message, maxTokens = 8000): Message {
	const content = typeof message.content === "string" ? message.content : ""
	const currentTokens = estimateMessageTokens(message)

	if (currentTokens <= maxTokens) {
		return message
	}

	consola.debug(
		`[ContextTruncation] Compressing tool result: ${currentTokens} tokens -> ${maxTokens} tokens`,
	)

	// 计算需要保留的字符数
	const ratio = maxTokens / currentTokens
	const targetLength = Math.floor(content.length * ratio * 0.9) // 留一些余量

	// 保留开头和结尾，中间用省略号
	const headLength = Math.floor(targetLength * 0.6)
	const tailLength = Math.floor(targetLength * 0.3)

	const truncatedContent =
		content.slice(0, headLength) +
		"\n\n... [内容已截断，中间省略 " +
		(content.length - headLength - tailLength) +
		" 字符] ...\n\n" +
		content.slice(-tailLength)

	return {
		...message,
		content: truncatedContent,
	}
}

/**
 * 智能截断消息列表
 *
 * 策略：
 * 1. 系统消息始终保留
 * 2. 优先保留最近的消息
 * 3. 优先保留完整的工具调用链
 * 4. 压缩过大的工具结果
 */
export function truncateMessagesSmart(
	messages: Message[],
	model: string,
	targetTokens?: number,
): TruncationResult {
	const target = targetTokens ?? getDynamicTargetLimit(model)

	// 计算原始 token 数
	let originalTokens = 0
	const messageTokens: number[] = []
	for (const msg of messages) {
		const tokens = estimateMessageTokens(msg)
		messageTokens.push(tokens)
		originalTokens += tokens
	}

	// 如果不需要截断，直接返回
	if (originalTokens <= target) {
		consola.debug(
			`[ContextTruncation] No truncation needed: ${originalTokens} tokens <= ${target} limit`,
		)
		return {
			messages: [...messages],
			originalTokens,
			truncatedTokens: originalTokens,
			removedCount: 0,
			compressedCount: 0,
		}
	}

	consola.info(
		`[ContextTruncation] Truncating: ${originalTokens} tokens -> ${target} limit (model: ${model})`,
	)

	// 分类消息
	const categorized: { msg: Message; category: MessageCategory; tokens: number; index: number }[] = []
	for (let i = 0; i < messages.length; i++) {
		categorized.push({
			msg: messages[i],
			category: categorizeMessage(messages[i]),
			tokens: messageTokens[i],
			index: i,
		})
	}

	// 步骤1：压缩大的工具结果
	let compressedCount = 0
	const compressed = categorized.map((item) => {
		if (item.msg.role === "tool" && item.tokens > 8000) {
			const compressedMsg = compressToolResult(item.msg)
			const newTokens = estimateMessageTokens(compressedMsg)
			if (newTokens < item.tokens) {
				compressedCount++
				return { ...item, msg: compressedMsg, tokens: newTokens }
			}
		}
		return item
	})

	// 重新计算 token 数
	let currentTokens = compressed.reduce((sum, item) => sum + item.tokens, 0)

	// 如果压缩后足够，返回结果
	if (currentTokens <= target) {
		consola.info(
			`[ContextTruncation] After compression: ${currentTokens} tokens (compressed ${compressedCount} tool results)`,
		)
		return {
			messages: compressed.map((item) => item.msg),
			originalTokens,
			truncatedTokens: currentTokens,
			removedCount: 0,
			compressedCount,
		}
	}

	// 步骤2：标记必须保留的消息
	// - 系统消息
	// - 最后一轮的工具调用链
	const mustKeep = new Set<number>()

	// 系统消息必须保留
	for (const item of compressed) {
		if (item.category === "system") {
			mustKeep.add(item.index)
		}
	}

	// 保留最后一轮工具调用链（最后的 tool 消息及其对应的 assistant tool_calls）
	let lastToolIndex = -1
	for (let i = compressed.length - 1; i >= 0; i--) {
		if (compressed[i].category === "tool_context") {
			lastToolIndex = i
			break
		}
	}

	if (lastToolIndex >= 0) {
		// 从最后一个 tool 消息往前找，保留完整的调用链
		for (let i = lastToolIndex; i >= 0; i--) {
			const item = compressed[i]
			if (item.category === "tool_context") {
				mustKeep.add(item.index)
			} else if (item.category === "regular" && i < lastToolIndex) {
				// 遇到非工具消息就停止
				break
			}
		}
	}

	// 始终保留最后一条用户消息
	for (let i = compressed.length - 1; i >= 0; i--) {
		if (compressed[i].msg.role === "user") {
			mustKeep.add(compressed[i].index)
			break
		}
	}

	// 步骤3：从中间删除消息，保留开头和结尾
	const result: typeof compressed = []
	let removedCount = 0

	// 计算必须保留的消息的 token 数
	let mustKeepTokens = 0
	for (const item of compressed) {
		if (mustKeep.has(item.index)) {
			mustKeepTokens += item.tokens
		}
	}

	// 计算可用于其他消息的 token 数
	const availableTokens = target - mustKeepTokens

	// 从后往前添加消息，优先保留最近的
	const regularMessages: typeof compressed = []
	for (const item of compressed) {
		if (!mustKeep.has(item.index) && item.category === "regular") {
			regularMessages.push(item)
		}
	}

	// 从最近的消息开始添加
	let usedTokens = 0
	const keepRegular = new Set<number>()
	for (let i = regularMessages.length - 1; i >= 0; i--) {
		const item = regularMessages[i]
		if (usedTokens + item.tokens <= availableTokens) {
			usedTokens += item.tokens
			keepRegular.add(item.index)
		}
	}

	// 构建最终结果
	for (const item of compressed) {
		if (mustKeep.has(item.index) || keepRegular.has(item.index)) {
			result.push(item)
		} else {
			removedCount++
		}
	}

	// 按原始顺序排序
	result.sort((a, b) => a.index - b.index)

	const truncatedTokens = result.reduce((sum, item) => sum + item.tokens, 0)

	consola.info(
		`[ContextTruncation] Truncation complete: ${originalTokens} -> ${truncatedTokens} tokens (removed ${removedCount} messages, compressed ${compressedCount} tool results)`,
	)

	return {
		messages: result.map((item) => item.msg),
		originalTokens,
		truncatedTokens,
		removedCount,
		compressedCount,
	}
}

/**
 * 检查是否需要截断
 */
export function needsTruncation(messages: Message[], model: string): boolean {
	const target = getDynamicTargetLimit(model)
	let totalTokens = 0

	for (const msg of messages) {
		totalTokens += estimateMessageTokens(msg)
		if (totalTokens > target) {
			return true
		}
	}

	return false
}

/**
 * 获取消息的总 token 数
 */
export function getTotalTokens(messages: Message[]): number {
	return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}

export { getModelContextLimit, getDynamicTargetLimit }
