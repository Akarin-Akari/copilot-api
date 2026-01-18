import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { truncateMessagesSmart, needsTruncation } from "~/lib/context-truncation"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type Message,
} from "~/services/copilot/create-chat-completions"

/**
 * Sanitizes tool_call.id to match the pattern ^[a-zA-Z0-9_-]+
 * Required by Copilot API for Codex/GPT models
 * @param id - The original tool_call.id
 * @returns A sanitized ID that matches the required pattern
 */
function sanitizeToolId(id: string): string {
  if (!id) {
    // Generate a fallback ID if empty
    const fallbackId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    consola.warn(
      `[sanitizeToolId] Empty tool ID, generated fallback: ${fallbackId}`,
    )
    return fallbackId
  }
  // Remove any characters that don't match [a-zA-Z0-9_-]
  const sanitized = id.replaceAll(/[^\w-]/g, "")
  if (!sanitized) {
    // If all characters were removed, generate a fallback
    const fallbackId = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    consola.warn(
      `[sanitizeToolId] All characters removed from "${id}", generated fallback: ${fallbackId}`,
    )
    return fallbackId
  }
  if (sanitized !== id) {
    consola.debug(
      `[sanitizeToolId] Sanitized tool ID: "${id}" -> "${sanitized}"`,
    )
  }
  return sanitized
}

/**
 * Sanitizes all tool_call IDs in messages to match the required pattern
 */
function sanitizeToolIdsInMessages(messages: Array<Message>): Array<Message> {
  return messages.map((msg) => {
    const sanitizedMsg = { ...msg }

    // Sanitize tool_call_id in tool messages
    if (msg.role === "tool" && msg.tool_call_id) {
      sanitizedMsg.tool_call_id = sanitizeToolId(msg.tool_call_id)
    }

    // Sanitize tool_calls[].id in assistant messages
    if (
      msg.role === "assistant"
      && msg.tool_calls
      && msg.tool_calls.length > 0
    ) {
      sanitizedMsg.tool_calls = msg.tool_calls.map((tc) => ({
        ...tc,
        id: sanitizeToolId(tc.id),
      }))
    }

    return sanitizedMsg
  })
}

/**
 * Validates and fixes tool_calls message format issues.
 * OpenAI API requires:
 * 1. Every assistant message with tool_calls must be IMMEDIATELY followed by corresponding tool messages
 * 2. Every tool message must reference a tool_call_id that exists in the IMMEDIATELY PRECEDING assistant message
 * 3. Tool responses cannot be separated from their assistant message by other messages
 *
 * This fix reorganizes messages to ensure proper ordering.
 */
function fixToolCallsMessages(messages: Array<Message>): Array<Message> {
  // Debug: Log message structure
  let assistantWithToolCallsCount = 0
  let toolResponseCount = 0

  for (const msg of messages) {
    if (
      msg.role === "assistant"
      && msg.tool_calls
      && msg.tool_calls.length > 0
    ) {
      assistantWithToolCallsCount++
    }
    if (msg.role === "tool" && msg.tool_call_id) {
      toolResponseCount++
    }
  }

  consola.info(
    `[ToolCallsFix] Analyzing: ${messages.length} messages, ${assistantWithToolCallsCount} assistant msgs with tool_calls, ${toolResponseCount} tool responses`,
  )

  // Build a map of tool_call_id -> tool response message
  const toolResponseMap = new Map<string, Message>()
  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      toolResponseMap.set(msg.tool_call_id, msg)
    }
  }

  // Build a map of tool_call_id -> assistant message index (for validation)
  const toolCallIdToAssistantIndex = new Map<string, number>()
  for (const [i, msg] of messages.entries()) {
    if (
      msg.role === "assistant"
      && msg.tool_calls
      && msg.tool_calls.length > 0
    ) {
      for (const tc of msg.tool_calls) {
        toolCallIdToAssistantIndex.set(tc.id, i)
      }
    }
  }

  // Rebuild messages with proper ordering:
  // After each assistant message with tool_calls, immediately insert all corresponding tool responses
  const fixedMessages: Array<Message> = []
  const usedToolResponseIds = new Set<string>()

  for (const msg of messages) {
    // Skip tool messages - we'll insert them in the right place
    if (msg.role === "tool") {
      continue
    }

    fixedMessages.push(msg)

    // If this is an assistant message with tool_calls, insert tool responses immediately after
    if (
      msg.role === "assistant"
      && msg.tool_calls
      && msg.tool_calls.length > 0
    ) {
      for (const tc of msg.tool_calls) {
        const toolResponse = toolResponseMap.get(tc.id)
        if (toolResponse) {
          fixedMessages.push(toolResponse)
          usedToolResponseIds.add(tc.id)
          consola.debug(
            `[ToolCallsFix] Placed tool response for ${tc.id} immediately after assistant message`,
          )
        } else {
          // Add placeholder for missing tool response
          const placeholderResponse: Message = {
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              status: "skipped",
              reason: "Tool execution was interrupted or skipped",
              tool_name: tc.function?.name || "unknown",
            }),
          }
          fixedMessages.push(placeholderResponse)
          consola.info(
            `[ToolCallsFix] Added placeholder for missing tool_call_id: ${tc.id} (tool: ${tc.function?.name || "unknown"})`,
          )
        }
      }
    }
  }

  // Check for orphaned tool responses (tool responses without matching tool_calls)
  const orphanedCount = toolResponseMap.size - usedToolResponseIds.size
  if (orphanedCount > 0) {
    consola.warn(
      `[ToolCallsFix] Removed ${orphanedCount} orphaned tool responses`,
    )
  }

  consola.info(
    `[ToolCallsFix] Result: ${messages.length} -> ${fixedMessages.length} messages (reordered and fixed)`,
  )

  return fixedMessages
}

/**
 * Translates model names to Copilot-compatible versions.
 *
 * Handles:
 * 1. Claude Code subagent requests with version suffixes (e.g., claude-sonnet-4-20250514 -> claude-sonnet-4)
 * 2. Codex CLI models with -codex suffix (e.g., gpt-5.2-codex -> gpt-5.2)
 * 3. Codex completion models that don't support /chat/completions (e.g., gpt-5.1-codex-max -> gpt-5.1)
 *
 * The -codex suffix is added by Codex CLI to identify requests but is not recognized by Copilot API.
 * Some codex models (like gpt-5.1-codex-max) are completion-only models and need to be mapped to chat models.
 */
function translateModelName(model: string): string {
  const modelLower = model.toLowerCase()

  // Claude models: strip version suffix (e.g., claude-sonnet-4-20250514 -> claude-sonnet-4)
  if (model.startsWith("claude-sonnet-4-")) {
    return "claude-sonnet-4"
  }
  if (model.startsWith("claude-opus-4-")) {
    return "claude-opus-4"
  }
  if (model.startsWith("claude-haiku-4-")) {
    return "claude-haiku-4"
  }

  // GPT-5.1 codex models: these are completion-only models, map to gpt-5.1
  // Error: "model gpt-5.1-codex-max is not accessible via the /chat/completions endpoint"
  if (modelLower.includes("gpt") && modelLower.includes("5.1") && modelLower.includes("codex")) {
    consola.debug(`[ModelTranslation] Mapping codex completion model to chat model: "${model}" -> "gpt-5.1"`)
    return "gpt-5.1"
  }

  // GPT-5.2 with -codex suffix: strip the suffix
  // Codex CLI adds -codex suffix but Copilot API doesn't recognize it
  if (modelLower.includes("gpt") && modelLower.endsWith("-codex")) {
    // Remove -codex suffix
    const baseModel = model.slice(0, -6) // Remove "-codex"
    consola.debug(`[ModelTranslation] Stripping -codex suffix: "${model}" -> "${baseModel}"`)
    return baseModel
  }

  // All other models are passed through as-is
  return model
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Translate model name to Copilot-compatible version
  const originalModel = payload.model
  const translatedModel = translateModelName(payload.model)
  if (translatedModel !== originalModel) {
    consola.info(
      `[ModelTranslation] "${originalModel}" -> "${translatedModel}"`,
    )
  }

  // Sanitize tool_call IDs to match required pattern ^[a-zA-Z0-9_-]+
  // Then fix tool_calls message format issues before forwarding (for codex compatibility)
  let processedMessages = fixToolCallsMessages(sanitizeToolIdsInMessages(payload.messages))

  // Apply context truncation if needed to avoid token limit errors
  if (needsTruncation(processedMessages, translatedModel)) {
    const truncationResult = truncateMessagesSmart(
      processedMessages,
      translatedModel,
    )
    processedMessages = truncationResult.messages
    consola.info(
      `[ContextTruncation] Applied: ${truncationResult.originalTokens} -> ${truncationResult.truncatedTokens} tokens ` +
      `(removed ${truncationResult.removedCount} msgs, compressed ${truncationResult.compressedCount} tool results)`,
    )
  }

  payload = {
    ...payload,
    model: translatedModel,
    messages: processedMessages,
  }

  // Find the selected model
  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info("Current token count:", tokenCount)
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  const response = await createChatCompletions(payload)

  if (isNonStreaming(response)) {
    consola.debug("Non-streaming response:", JSON.stringify(response))
    return c.json(response)
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      consola.debug("Streaming chunk:", JSON.stringify(chunk))
      await stream.writeSSE(chunk as SSEMessage)
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
