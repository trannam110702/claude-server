// OpenAI <-> Claude format translation

// Convert OpenAI chat completion request to Claude messages format
export function openaiToClaude(body) {
  const result = {
    model: body.model,
    max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
    stream: body.stream || false
  };

  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  // Messages
  result.messages = [];
  const systemParts = [];

  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === "system") {
        systemParts.push(typeof msg.content === "string" ? msg.content : extractText(msg.content));
      }
    }

    const nonSystemMessages = body.messages.filter(m => m.role !== "system");

    let currentRole = undefined;
    let currentParts = [];

    const flush = () => {
      if (currentRole && currentParts.length > 0) {
        result.messages.push({ role: currentRole, content: currentParts });
        currentParts = [];
      }
    };

    for (const msg of nonSystemMessages) {
      const newRole = (msg.role === "user" || msg.role === "tool") ? "user" : "assistant";
      const blocks = messageToBlocks(msg);
      const hasToolResult = blocks.some(b => b.type === "tool_result");
      const hasToolUse = blocks.some(b => b.type === "tool_use");

      if (hasToolResult) {
        const toolResultBlocks = blocks.filter(b => b.type === "tool_result");
        const otherBlocks = blocks.filter(b => b.type !== "tool_result");
        flush();
        if (toolResultBlocks.length > 0) {
          result.messages.push({ role: "user", content: toolResultBlocks });
        }
        if (otherBlocks.length > 0) {
          currentRole = newRole;
          currentParts.push(...otherBlocks);
        }
        continue;
      }

      if (currentRole !== newRole) {
        flush();
        currentRole = newRole;
      }

      currentParts.push(...blocks);

      if (hasToolUse) flush();
    }

    flush();

    // Add cache_control to last assistant message
    for (let i = result.messages.length - 1; i >= 0; i--) {
      const message = result.messages[i];
      if (message.role === "assistant" && Array.isArray(message.content) && message.content.length > 0) {
        message.content[message.content.length - 1].cache_control = { type: "ephemeral" };
        break;
      }
    }
  }

  // System prompt
  if (systemParts.length > 0) {
    result.system = [
      { type: "text", text: systemParts.join("\n"), cache_control: { type: "ephemeral" } }
    ];
  }

  // Handle response_format
  if (body.response_format) {
    if (body.response_format.type === "json_schema" && body.response_format.json_schema?.schema) {
      const schemaJson = JSON.stringify(body.response_format.json_schema.schema, null, 2);
      const jsonPrompt = `You must respond with valid JSON that strictly follows this JSON schema:\n\`\`\`json\n${schemaJson}\n\`\`\`\nRespond ONLY with the JSON object, no other text.`;
      if (!result.system) result.system = [];
      result.system.push({ type: "text", text: jsonPrompt });
    } else if (body.response_format.type === "json_object") {
      if (!result.system) result.system = [];
      result.system.push({ type: "text", text: "You must respond with valid JSON. Respond ONLY with a JSON object, no other text." });
    }
  }

  // Tools
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = [];
    for (const tool of body.tools) {
      if (tool.type && tool.type !== "function") {
        result.tools.push(tool);
        continue;
      }
      const toolData = tool.type === "function" && tool.function ? tool.function : tool;
      result.tools.push({
        name: toolData.name,
        description: toolData.description || "",
        input_schema: toolData.parameters || toolData.input_schema || { type: "object", properties: {}, required: [] }
      });
    }
    if (result.tools.length > 0) {
      result.tools[result.tools.length - 1].cache_control = { type: "ephemeral" };
    }
  }

  // Tool choice
  if (body.tool_choice) {
    if (typeof body.tool_choice === "string") {
      if (body.tool_choice === "required") result.tool_choice = { type: "any" };
      else result.tool_choice = { type: "auto" };
    } else if (body.tool_choice.function) {
      result.tool_choice = { type: "tool", name: body.tool_choice.function.name };
    } else if (body.tool_choice.type) {
      result.tool_choice = body.tool_choice;
    }
  }

  // Thinking
  if (body.thinking) {
    result.thinking = {
      type: body.thinking.type || "enabled",
      ...(body.thinking.budget_tokens && { budget_tokens: body.thinking.budget_tokens }),
      ...(body.thinking.max_tokens && { max_tokens: body.thinking.max_tokens })
    };
  }

  return result;
}

// Convert Claude non-streaming response to OpenAI format
export function claudeToOpenai(response) {
  let content = null;
  let toolCalls = null;

  if (response.content && Array.isArray(response.content)) {
    const textParts = response.content.filter(b => b.type === "text").map(b => b.text);
    if (textParts.length > 0) content = textParts.join("");

    const toolUseParts = response.content.filter(b => b.type === "tool_use");
    if (toolUseParts.length > 0) {
      toolCalls = toolUseParts.map((tu, i) => ({
        index: i,
        id: tu.id,
        type: "function",
        function: {
          name: tu.name,
          arguments: JSON.stringify(tu.input)
        }
      }));
    }
  }

  const finishReason = convertStopReason(response.stop_reason);

  const message = { role: "assistant" };
  if (content !== null) message.content = content;
  if (toolCalls) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${response.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason
    }],
    usage: {
      prompt_tokens: response.usage?.input_tokens || 0,
      completion_tokens: response.usage?.output_tokens || 0,
      total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
    }
  };
}

// State factory for streaming translation
export function createStreamState() {
  return {
    messageId: null,
    model: null,
    toolCallIndex: 0,
    toolCalls: new Map(),
    textBlockStarted: false,
    inThinkingBlock: false,
    currentBlockIndex: -1,
    serverToolBlockIndex: -1,
    finishReason: null,
    finishReasonSent: false,
    usage: null
  };
}

// Convert a single Claude SSE chunk to OpenAI streaming format
// Returns array of OpenAI chunks or null
export function claudeStreamChunkToOpenai(chunk, state) {
  if (!chunk) return null;
  const results = [];

  function createChunk(delta, finishReason = null) {
    return {
      id: `chatcmpl-${state.messageId}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    };
  }

  switch (chunk.type) {
    case "message_start": {
      state.messageId = chunk.message?.id || `msg_${Date.now()}`;
      state.model = chunk.message?.model;
      state.toolCallIndex = 0;
      results.push(createChunk({ role: "assistant" }));
      break;
    }

    case "content_block_start": {
      const block = chunk.content_block;
      if (block?.type === "server_tool_use") {
        state.serverToolBlockIndex = chunk.index;
        break;
      }
      if (block?.type === "text") {
        state.textBlockStarted = true;
      } else if (block?.type === "thinking") {
        state.inThinkingBlock = true;
        state.currentBlockIndex = chunk.index;
        results.push(createChunk({ content: "<think>" }));
      } else if (block?.type === "tool_use") {
        const toolCallIndex = state.toolCallIndex++;
        const toolCall = {
          index: toolCallIndex,
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: "" }
        };
        state.toolCalls.set(chunk.index, toolCall);
        results.push(createChunk({ tool_calls: [toolCall] }));
      }
      break;
    }

    case "content_block_delta": {
      if (chunk.index === state.serverToolBlockIndex) break;
      const delta = chunk.delta;
      if (delta?.type === "text_delta" && delta.text) {
        results.push(createChunk({ content: delta.text }));
      } else if (delta?.type === "thinking_delta" && delta.thinking) {
        results.push(createChunk({ reasoning_content: delta.thinking }));
      } else if (delta?.type === "input_json_delta" && delta.partial_json) {
        const toolCall = state.toolCalls.get(chunk.index);
        if (toolCall) {
          toolCall.function.arguments += delta.partial_json;
          results.push(createChunk({
            tool_calls: [{
              index: toolCall.index,
              id: toolCall.id,
              function: { arguments: delta.partial_json }
            }]
          }));
        }
      }
      break;
    }

    case "content_block_stop": {
      if (chunk.index === state.serverToolBlockIndex) {
        state.serverToolBlockIndex = -1;
        break;
      }
      if (state.inThinkingBlock && chunk.index === state.currentBlockIndex) {
        results.push(createChunk({ reasoning_content: "" }));
        state.inThinkingBlock = false;
      }
      state.textBlockStarted = false;
      break;
    }

    case "message_delta": {
      if (chunk.usage) {
        const inputTokens = chunk.usage.input_tokens || 0;
        const outputTokens = chunk.usage.output_tokens || 0;
        const cacheRead = chunk.usage.cache_read_input_tokens || 0;
        const cacheCreation = chunk.usage.cache_creation_input_tokens || 0;
        state.usage = {
          prompt_tokens: inputTokens + cacheRead + cacheCreation,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + cacheRead + cacheCreation + outputTokens
        };
      }

      if (chunk.delta?.stop_reason) {
        state.finishReason = convertStopReason(chunk.delta.stop_reason);
        const finalChunk = createChunk({}, state.finishReason);
        if (state.usage) finalChunk.usage = state.usage;
        results.push(finalChunk);
        state.finishReasonSent = true;
      }
      break;
    }

    case "message_stop": {
      if (!state.finishReasonSent) {
        const finishReason = state.finishReason || (state.toolCalls.size > 0 ? "tool_calls" : "stop");
        const finalChunk = createChunk({}, finishReason);
        if (state.usage) finalChunk.usage = state.usage;
        results.push(finalChunk);
        state.finishReasonSent = true;
      }
      break;
    }
  }

  return results.length > 0 ? results : null;
}

// Helpers

function convertStopReason(reason) {
  switch (reason) {
    case "end_turn": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    case "stop_sequence": return "stop";
    default: return "stop";
  }
}

function messageToBlocks(msg) {
  const blocks = [];

  if (msg.role === "tool") {
    blocks.push({
      type: "tool_result",
      tool_use_id: msg.tool_call_id,
      content: msg.content
    });
  } else if (msg.role === "user") {
    if (typeof msg.content === "string") {
      if (msg.content) blocks.push({ type: "text", text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          blocks.push({ type: "text", text: part.text });
        } else if (part.type === "tool_result") {
          blocks.push({
            type: "tool_result",
            tool_use_id: part.tool_use_id,
            content: part.content,
            ...(part.is_error && { is_error: part.is_error })
          });
        } else if (part.type === "image_url") {
          const url = part.image_url.url;
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            blocks.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
          } else if (url.startsWith("http")) {
            blocks.push({ type: "image", source: { type: "url", url } });
          }
        } else if (part.type === "image" && part.source) {
          blocks.push({ type: "image", source: part.source });
        }
      }
    }
  } else if (msg.role === "assistant") {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          blocks.push({ type: "text", text: part.text });
        } else if (part.type === "tool_use") {
          blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
        }
      }
    } else if (msg.content) {
      const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
      if (text) blocks.push({ type: "text", text });
    }

    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.type === "function") {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: tryParseJSON(tc.function.arguments)
          });
        }
      }
    }
  }

  return blocks;
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === "text").map(c => c.text).join("\n");
  }
  return "";
}

function tryParseJSON(str) {
  if (typeof str !== "string") return str;
  try { return JSON.parse(str); } catch { return str; }
}
