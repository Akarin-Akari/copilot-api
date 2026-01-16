import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
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
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
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
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
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
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
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

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  // Fix tool_calls message format issues before forwarding (for codex compatibility)
  payload = {
    ...payload,
    messages: fixToolCallsMessages(payload.messages),
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
