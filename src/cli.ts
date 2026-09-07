#!/usr/bin/env node

const command = process.argv[2] ?? "start";

if (command !== "gateway") {
  await import("./cli-core.js");
} else {
  const subcommand = process.argv[3] ?? "start";
  const rest = process.argv.slice(4);

  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printGatewayUsage();
  } else if (subcommand === "start" || subcommand === "serve") {
    if (rest.some((argument) => argument === "--allow-unsafe-full-access")) {
      console.error("Gateway mode exposes no workspace or shell tools; --allow-unsafe-full-access is not applicable.");
      process.exitCode = 1;
    } else if (rest.some((argument) => argument === "--mode" || argument.startsWith("--mode="))) {
      console.error("Gateway mode manages its own MCP catalog and cannot be combined with --mode.");
      process.exitCode = 1;
    } else {
      process.env.PI_LLM_GATEWAY_ENABLED = "true";
      process.env.PI_CHAT_CLI = "off";
      process.argv.splice(2, 2, subcommand);
      await import("./cli-core.js");
    }
  } else if (subcommand === "status") {
    if (rest.length > 0) {
      printGatewayUsage();
      process.exitCode = 1;
    } else {
      const { runGatewayControl } = await import("./llm-gateway-control.js");
      process.exitCode = await runGatewayControl("status");
    }
  } else if (subcommand === "release") {
    const reason = rest.join(" ").trim() || undefined;
    const { runGatewayControl } = await import("./llm-gateway-control.js");
    process.exitCode = await runGatewayControl("release", reason);
  } else {
    console.error(`Unknown gateway command '${subcommand}'.`);
    printGatewayUsage();
    process.exitCode = 1;
  }
}

function printGatewayUsage(): void {
  console.error("Usage: pilink gateway <start|serve|status|release> [options]");
  console.error("");
  console.error("  pilink gateway start              Start PiLink hosting with the persistent ChatGPT LLM gateway catalog");
  console.error("  pilink gateway serve              Serve the gateway on the configured MCP origin without managing public hosting");
  console.error("  pilink gateway status             Read local gateway lifecycle and queue status");
  console.error("  pilink gateway release [reason]   Permanently end the active gateway loop until the server is restarted");
  console.error("");
  console.error("The OpenAI-compatible API is loopback-only. By default its port is MCP PORT + 10 (3200 -> 3210).");
  console.error("The only OpenAI-compatible inference route is POST /v1/chat/completions with model, messages, and optional stream=false.");
}
