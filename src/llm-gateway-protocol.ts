export const GATEWAY_MODEL = "pilink";
export const GATEWAY_ROLES = ["system", "developer", "user", "assistant", "tool"] as const;
export type GatewayRole = typeof GATEWAY_ROLES[number];

export type GatewayJsonValue = null | boolean | number | string | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface GatewayMessage {
  role: GatewayRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: GatewayToolCall[];
}

export interface GatewayFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: GatewayJsonObject;
    strict?: boolean;
  };
}

export type GatewayToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
      type: "function";
      function: { name: string };
    };

export interface GatewayRequestPayload {
  model: string;
  messages: GatewayMessage[];
  tools?: GatewayFunctionTool[];
  toolChoice?: GatewayToolChoice;
  parallelToolCalls?: boolean;
}

export interface GatewayAssistantCompletion {
  content: string | null;
  tool_calls?: GatewayToolCall[];
}

const MAX_MODEL_BYTES = 128;
const MAX_MESSAGES = 256;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_TOTAL_MESSAGE_BYTES = 1024 * 1024;
const MAX_TOOLS = 128;
const MAX_TOOL_DESCRIPTION_BYTES = 64 * 1024;
const MAX_TOOL_SCHEMA_BYTES = 256 * 1024;
const MAX_TOTAL_TOOLS_BYTES = 1024 * 1024;
const MAX_TOOL_CALLS = 128;
const MAX_TOOL_CALL_ARGUMENT_BYTES = 1024 * 1024;
const MAX_COMPLETION_BYTES = 4 * 1024 * 1024;
const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export function validateGatewayRequestPayload(input: unknown): GatewayRequestPayload {
  if (!isRecord(input)) throw new Error("Gateway request payload must be an object");
  if (typeof input.model !== "string") throw new Error("model must be a string");
  const model = validateText(input.model, "model", MAX_MODEL_BYTES);
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > MAX_MESSAGES) {
    throw new Error(`messages must contain from 1 through ${MAX_MESSAGES} entries`);
  }

  let totalMessageBytes = 0;
  const messages = input.messages.map((message, index) => {
    const normalized = validateGatewayMessage(message, `messages[${index}]`);
    totalMessageBytes += Buffer.byteLength(JSON.stringify(normalized), "utf8");
    return normalized;
  });
  if (totalMessageBytes > MAX_TOTAL_MESSAGE_BYTES) {
    throw new Error(`messages exceed ${MAX_TOTAL_MESSAGE_BYTES} UTF-8 bytes`);
  }

  const tools = input.tools === undefined ? undefined : validateGatewayTools(input.tools);
  const toolChoice = input.toolChoice === undefined ? undefined : validateGatewayToolChoice(input.toolChoice);
  const parallelToolCalls = input.parallelToolCalls === undefined
    ? undefined
    : validateBoolean(input.parallelToolCalls, "parallelToolCalls");

  if (toolChoice && typeof toolChoice === "object") {
    if (!tools?.some((tool) => tool.function.name === toolChoice.function.name)) {
      throw new Error(`toolChoice references unavailable function '${toolChoice.function.name}'`);
    }
  }
  if ((toolChoice === "required" || (toolChoice && typeof toolChoice === "object")) && (!tools || tools.length === 0)) {
    throw new Error("toolChoice requires at least one function tool");
  }

  return {
    model,
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
  };
}

export function validateGatewayAssistantCompletion(
  input: unknown,
  request?: Pick<GatewayRequestPayload, "tools" | "toolChoice" | "parallelToolCalls">,
): GatewayAssistantCompletion {
  const normalized = typeof input === "string"
    ? { content: validateText(input, "assistant content", MAX_COMPLETION_BYTES, true) }
    : validateAssistantObject(input);

  const encodedBytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
  if (encodedBytes > MAX_COMPLETION_BYTES) {
    throw new Error(`assistant completion exceeds ${MAX_COMPLETION_BYTES} UTF-8 bytes`);
  }

  if (request) enforceToolContract(normalized, request);
  return normalized;
}

export function copyGatewayMessage(message: GatewayMessage): GatewayMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id }),
    ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls.map(copyGatewayToolCall) }),
  };
}

export function copyGatewayTool(tool: GatewayFunctionTool): GatewayFunctionTool {
  return {
    type: "function",
    function: {
      name: tool.function.name,
      ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
      ...(tool.function.parameters === undefined ? {} : { parameters: cloneJsonObject(tool.function.parameters) }),
      ...(tool.function.strict === undefined ? {} : { strict: tool.function.strict }),
    },
  };
}

export function copyGatewayToolChoice(choice: GatewayToolChoice): GatewayToolChoice {
  return typeof choice === "string"
    ? choice
    : { type: "function", function: { name: choice.function.name } };
}

export function copyGatewayAssistantCompletion(completion: GatewayAssistantCompletion): GatewayAssistantCompletion {
  return {
    content: completion.content,
    ...(completion.tool_calls === undefined ? {} : { tool_calls: completion.tool_calls.map(copyGatewayToolCall) }),
  };
}

function validateGatewayMessage(input: unknown, field: string): GatewayMessage {
  if (!isRecord(input) || typeof input.role !== "string" || !GATEWAY_ROLES.includes(input.role as GatewayRole)) {
    throw new Error(`${field} role is invalid`);
  }
  const role = input.role as GatewayRole;
  const content = input.content;
  if (content !== null && typeof content !== "string") throw new Error(`${field} content must be a string or null`);
  if (content === null && role !== "assistant") throw new Error(`${field} content may be null only for assistant messages`);
  const normalized: GatewayMessage = {
    role,
    content: content === null ? null : validateText(content, `${field} content`, MAX_MESSAGE_BYTES, true),
  };

  if (input.name !== undefined) normalized.name = validateSingleLine(input.name, `${field} name`, 256);
  if (input.tool_call_id !== undefined) {
    normalized.tool_call_id = validateSingleLine(input.tool_call_id, `${field} tool_call_id`, 512);
  }
  if (input.tool_calls !== undefined) {
    if (role !== "assistant") throw new Error(`${field} tool_calls are allowed only on assistant messages`);
    normalized.tool_calls = validateGatewayToolCalls(input.tool_calls, `${field} tool_calls`);
  }

  if (role === "tool" && !normalized.tool_call_id) throw new Error(`${field} tool messages require tool_call_id`);
  if (role !== "tool" && normalized.tool_call_id !== undefined) throw new Error(`${field} tool_call_id is allowed only on tool messages`);
  if (role === "assistant" && normalized.content === null && (!normalized.tool_calls || normalized.tool_calls.length === 0)) {
    throw new Error(`${field} assistant messages require content or tool_calls`);
  }
  return normalized;
}

function validateGatewayTools(input: unknown): GatewayFunctionTool[] {
  if (!Array.isArray(input) || input.length > MAX_TOOLS) throw new Error(`tools must contain at most ${MAX_TOOLS} entries`);
  const names = new Set<string>();
  let totalBytes = 0;
  const tools = input.map((candidate, index) => {
    if (!isRecord(candidate) || candidate.type !== "function" || !isRecord(candidate.function)) {
      throw new Error(`tools[${index}] must be a function tool`);
    }
    const name = validateFunctionName(candidate.function.name, `tools[${index}] function name`);
    if (names.has(name)) throw new Error(`Duplicate function tool '${name}'`);
    names.add(name);
    const description = candidate.function.description === undefined
      ? undefined
      : validateText(candidate.function.description, `tools[${index}] description`, MAX_TOOL_DESCRIPTION_BYTES, true);
    const parameters = candidate.function.parameters === undefined
      ? undefined
      : validateJsonObject(candidate.function.parameters, `tools[${index}] parameters`, MAX_TOOL_SCHEMA_BYTES);
    const strict = candidate.function.strict === undefined
      ? undefined
      : validateBoolean(candidate.function.strict, `tools[${index}] strict`);
    const tool: GatewayFunctionTool = {
      type: "function",
      function: {
        name,
        ...(description === undefined ? {} : { description }),
        ...(parameters === undefined ? {} : { parameters }),
        ...(strict === undefined ? {} : { strict }),
      },
    };
    totalBytes += Buffer.byteLength(JSON.stringify(tool), "utf8");
    return tool;
  });
  if (totalBytes > MAX_TOTAL_TOOLS_BYTES) throw new Error(`tools exceed ${MAX_TOTAL_TOOLS_BYTES} UTF-8 bytes`);
  return tools;
}

function validateGatewayToolChoice(input: unknown): GatewayToolChoice {
  if (input === "none" || input === "auto" || input === "required") return input;
  if (!isRecord(input) || input.type !== "function" || !isRecord(input.function)) throw new Error("toolChoice is invalid");
  return {
    type: "function",
    function: { name: validateFunctionName(input.function.name, "toolChoice function name") },
  };
}

function validateAssistantObject(input: unknown): GatewayAssistantCompletion {
  if (!isRecord(input)) throw new Error("assistant completion must be a string or object");
  for (const key of Object.keys(input)) {
    if (key !== "content" && key !== "tool_calls") throw new Error(`Unsupported assistant completion field '${key}'`);
  }
  const content = input.content === undefined || input.content === null
    ? null
    : validateText(input.content, "assistant content", MAX_COMPLETION_BYTES, true);
  const toolCalls = input.tool_calls === undefined
    ? undefined
    : validateGatewayToolCalls(input.tool_calls, "assistant tool_calls");
  if (content === null && (!toolCalls || toolCalls.length === 0)) {
    throw new Error("assistant completion requires content or tool_calls");
  }
  return {
    content,
    ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
  };
}

function validateGatewayToolCalls(input: unknown, field: string): GatewayToolCall[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_TOOL_CALLS) {
    throw new Error(`${field} must contain from 1 through ${MAX_TOOL_CALLS} calls`);
  }
  const ids = new Set<string>();
  return input.map((candidate, index) => {
    if (!isRecord(candidate) || candidate.type !== "function" || !isRecord(candidate.function)) {
      throw new Error(`${field}[${index}] must be a function call`);
    }
    const id = validateSingleLine(candidate.id, `${field}[${index}] id`, 512);
    if (ids.has(id)) throw new Error(`Duplicate tool call id '${id}'`);
    ids.add(id);
    const name = validateFunctionName(candidate.function.name, `${field}[${index}] function name`);
    const args = validateText(candidate.function.arguments, `${field}[${index}] arguments`, MAX_TOOL_CALL_ARGUMENT_BYTES, true);
    try {
      const parsed = JSON.parse(args);
      if (!isRecord(parsed)) throw new Error("not-object");
    } catch {
      throw new Error(`${field}[${index}] arguments must be a JSON object string`);
    }
    return { id, type: "function", function: { name, arguments: args } };
  });
}

function enforceToolContract(
  completion: GatewayAssistantCompletion,
  request: Pick<GatewayRequestPayload, "tools" | "toolChoice" | "parallelToolCalls">,
): void {
  const calls = completion.tool_calls ?? [];
  const available = new Set((request.tools ?? []).map((tool) => tool.function.name));
  for (const call of calls) {
    if (!available.has(call.function.name)) throw new Error(`Assistant called unavailable function '${call.function.name}'`);
  }
  if (request.parallelToolCalls === false && calls.length > 1) {
    throw new Error("Assistant returned parallel tool calls while parallelToolCalls=false");
  }
  if (request.toolChoice === "none" && calls.length > 0) throw new Error("Assistant returned tool calls while toolChoice=none");
  if (request.toolChoice === "required" && calls.length === 0) throw new Error("Assistant must return at least one tool call");
  if (request.toolChoice && typeof request.toolChoice === "object") {
    const requiredName = request.toolChoice.function.name;
    if (calls.length === 0 || calls.some((call) => call.function.name !== requiredName)) {
      throw new Error(`Assistant must call required function '${requiredName}'`);
    }
  }
}

function copyGatewayToolCall(call: GatewayToolCall): GatewayToolCall {
  return {
    id: call.id,
    type: "function",
    function: { name: call.function.name, arguments: call.function.arguments },
  };
}

function validateJsonObject(input: unknown, field: string, maximumBytes: number): GatewayJsonObject {
  if (!isRecord(input)) throw new Error(`${field} must be a JSON object`);
  const value = validateJsonValue(input, field, 0);
  if (!isRecord(value)) throw new Error(`${field} must be a JSON object`);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximumBytes) throw new Error(`${field} is too large`);
  return value as GatewayJsonObject;
}

function validateJsonValue(input: unknown, field: string, depth: number): GatewayJsonValue {
  if (depth > 64) throw new Error(`${field} exceeds maximum JSON nesting depth`);
  if (input === null || typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`${field} contains a non-finite number`);
    return input;
  }
  if (Array.isArray(input)) return input.map((item) => validateJsonValue(item, field, depth + 1));
  if (isRecord(input)) {
    const output: GatewayJsonObject = {};
    for (const [key, value] of Object.entries(input)) {
      if (/\0/u.test(key)) throw new Error(`${field} contains a NUL byte in an object key`);
      output[key] = validateJsonValue(value, field, depth + 1);
    }
    return output;
  }
  throw new Error(`${field} must contain JSON-compatible values only`);
}

function cloneJsonObject(input: GatewayJsonObject): GatewayJsonObject {
  return JSON.parse(JSON.stringify(input)) as GatewayJsonObject;
}

function validateFunctionName(value: unknown, field: string): string {
  if (typeof value !== "string" || !FUNCTION_NAME_PATTERN.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function validateText(value: unknown, field: string, maximumBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${field} must be a string without NUL bytes`);
  if (!allowEmpty && !value.trim()) throw new Error(`${field} must not be empty`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error(`${field} exceeds ${maximumBytes} UTF-8 bytes`);
  return value;
}

function validateSingleLine(value: unknown, field: string, maximumBytes: number): string {
  const selected = validateText(value, field, maximumBytes);
  if (/[\r\n]/u.test(selected)) throw new Error(`${field} must be one line`);
  return selected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
