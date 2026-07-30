// ─────────────────────────────────────────────────────────────
// PI-MCP: MCP Server & Native Pi Agent Harness Tools
// Exposes native Pi Agent tools and system prompt directly to MCP clients
// ─────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@earendil-works/pi-coding-agent";

const PI_WORK_DIR = process.env.PI_WORK_DIR || process.env.AGY_WORK_DIR || "/home/ubuntu";

/**
 * Factory: creates a fully-configured MCP server instance containing
 * the complete native Pi Agent tool harness & system prompt instructions.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "pi-mcp",
    version: "1.0.0",
  });

  const cwd = PI_WORK_DIR;

  // Initialize native Pi Agent tools bound to working directory
  const readTool = createReadTool(cwd);
  const bashTool = createBashTool(cwd);
  const editTool = createEditTool(cwd);
  const writeTool = createWriteTool(cwd);
  const grepTool = createGrepTool(cwd);
  const findTool = createFindTool(cwd);
  const lsTool = createLsTool(cwd);

  // Generate Pi Agent's native system prompt instructions
  function generatePiSystemPrompt(): string {
    const today = new Date().toISOString().split("T")[0];
    return `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents (text/images). Truncates large output.
- bash: Execute bash commands in current working directory. Returns stdout/stderr.
- edit: Edit files using exact text replacement (oldText -> newText).
- write: Write content to a file. Creates or overwrites.
- grep: Search file contents for regex or literal patterns.
- find: Search for files by glob pattern.
- ls: List directory contents with file sizes and type indicators.

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /home/ubuntu/.local/lib/node_modules/@earendil-works/pi-coding-agent/README.md
- Additional docs: /home/ubuntu/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs
- Examples: /home/ubuntu/.local/lib/node_modules/@earendil-works/pi-coding-agent/examples

Current date: ${today}
Current working directory: ${cwd}`;
  }

  // ── Prompt: pi_system_prompt ────────────────────────────
  server.prompt(
    "pi_system_prompt",
    "Returns the official Pi Agent system prompt and project guidelines.",
    async () => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: generatePiSystemPrompt(),
            },
          },
        ],
      };
    }
  );

  // ── Tool: get_system_prompt ─────────────────────────────
  server.tool(
    "get_system_prompt",
    "Get the official Pi Agent system prompt instructions and guidelines for this VPS workspace.",
    {},
    async () => {
      return {
        content: [{ type: "text" as const, text: generatePiSystemPrompt() }],
      };
    }
  );

  // ── Tool: read ──────────────────────────────────────────
  server.tool(
    "read",
    readTool.description,
    {
      path: z.string().describe("Path to the file to read (relative or absolute)"),
      offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
      limit: z.number().optional().describe("Maximum number of lines to read"),
    },
    async (args) => {
      const res = await readTool.execute(`call_${randomUUID()}`, args);
      return { content: res.content as any, isError: (res as any).isError };
    }
  );

  // ── Tool: bash ──────────────────────────────────────────
  server.tool(
    "bash",
    bashTool.description,
    {
      command: z.string().describe("Bash command to execute"),
      timeout: z.number().optional().describe("Timeout in seconds (optional)"),
    },
    async (args) => {
      const res = await bashTool.execute(`call_${randomUUID()}`, args);
      return { content: res.content as any, isError: (res as any).isError };
    }
  );

  // ── Tool: edit ──────────────────────────────────────────
  server.tool(
    "edit",
    editTool.description,
    {
      path: z.string().describe("Path to the file to edit (relative or absolute)"),
      edits: z
        .array(
          z.object({
            oldText: z.string().describe("Exact text for targeted replacement"),
            newText: z.string().describe("Replacement text"),
          })
        )
        .describe("One or more targeted replacements"),
    },
    async (args) => {
      const res = await editTool.execute(`call_${randomUUID()}`, args);
      return { content: res.content as any, isError: (res as any).isError };
    }
  );

  // ── Tool: write ─────────────────────────────────────────
  server.tool(
    "write",
    writeTool.description,
    {
      path: z.string().describe("Path to the file to write (relative or absolute)"),
      content: z.string().describe("Content to write to the file"),
    },
    async (args) => {
      const res = await writeTool.execute(`call_${randomUUID()}`, args);
      return { content: res.content as any, isError: (res as any).isError };
    }
  );

  // ── Tool: grep ──────────────────────────────────────────
  server.tool(
    "grep",
    grepTool.description,
    {
      pattern: z.string().describe("Search pattern (regex or literal string)"),
      path: z.string().optional().describe("Directory or file to search (default: current directory)"),
      glob: z.string().optional().describe("Filter files by glob pattern, e.g. '*.ts'"),
      ignoreCase: z.boolean().optional().describe("Case-insensitive search (default: false)"),
      literal: z.boolean().optional().describe("Treat pattern as literal string (default: false)"),
      context: z.number().optional().describe("Number of lines of context (default: 0)"),
      limit: z.number().optional().describe("Maximum number of matches (default: 100)"),
    },
    async (args) => {
      const res = await grepTool.execute(`call_${randomUUID()}`, args);
      return { content: res.content as any, isError: (res as any).isError };
    }
  );

  // ── Tool: find ──────────────────────────────────────────
  server.tool(
    "find",
    findTool.description,
    {
      pattern: z.string().describe("Glob pattern to match files, e.g. '*.ts' or '**/*.json'"),
      path: z.string().optional().describe("Directory to search in (default: current directory)"),
      limit: z.number().optional().describe("Maximum number of results (default: 1000)"),
    },
    async (args) => {
      const res = await findTool.execute(`call_${randomUUID()}`, args);
      return { content: res.content as any, isError: (res as any).isError };
    }
  );

  // ── Tool: ls ────────────────────────────────────────────
  server.tool(
    "ls",
    lsTool.description,
    {
      path: z.string().optional().describe("Directory to list (default: current directory)"),
      limit: z.number().optional().describe("Maximum number of entries to return (default: 500)"),
    },
    async (args) => {
      const res = await lsTool.execute(`call_${randomUUID()}`, args);
      return { content: res.content as any, isError: (res as any).isError };
    }
  );

  return server;
}
