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
      try {
        const { installGatewayCompactOutput } = await import("./llm-gateway-output.js");
        installGatewayCompactOutput();
        const { prepareGatewayLaunch } = await import("./llm-gateway-launch.js");
        await prepareGatewayLaunch(subcommand);
        // The gateway replaces the ordinary MCP catalog, so pin the underlying
        // core runtime to the least-privileged single mode and skip the normal
        // interactive 1/2/3 experience chooser.
        process.argv.splice(2, 2, subcommand, "--mode", "single");
        await import("./cli-core.js");

        // `cli-core` starts asynchronously. Wait for its private local admin
        // endpoint, then make this explicit local launch open the short DCR
        // window even when another OAuth client is already stored.
        const { openGatewayConnectorWindow, printGatewayReady } = await import("./llm-gateway-connect.js");
        const info = await openGatewayConnectorWindow();
        printGatewayReady(info);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    }
  } else if (subcommand === "connect") {
    if (rest.length > 0) {
      printGatewayUsage();
      process.exitCode = 1;
    } else {
      const { installGatewayCompactOutput } = await import("./llm-gateway-output.js");
      installGatewayCompactOutput();
      const { runGatewayConnect } = await import("./llm-gateway-connect.js");
      process.exitCode = await runGatewayConnect();
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
  console.error("Usage: pilink gateway <start|serve|connect|status|release> [options]");
  console.error("");
  console.error("  pilink gateway start              Start hosted PiLink gateway and open a short ChatGPT DCR window");
  console.error("  pilink gateway serve              Serve the configured gateway origin and open a short ChatGPT DCR window");
  console.error("  pilink gateway connect            Reopen the short ChatGPT OAuth/DCR registration window");
  console.error("  pilink gateway status             Read local gateway lifecycle and queue status");
  console.error("  pilink gateway release [reason]   Permanently end the active gateway loop until the server is restarted");
  console.error("");
  console.error("Gateway terminal output is compact by default. Set PILINK_TERMINAL_LOGS=verbose to restore raw diagnostics.");
  console.error("The gateway pins the underlying core runtime to single mode because the ordinary MCP catalog is replaced by gateway_exchange plus the local-tool dispatcher.");
  console.error("If the configured MCP port is busy, gateway start/serve selects the next free MCP/API loopback pair (3200 -> 3201, API 3210 -> 3211).");
  console.error("The selected fallback MCP port is saved so managed hosting and subsequent launches stay consistent.");
  console.error("The OpenAI-compatible API is loopback-only and normally uses MCP PORT + 10.");
  console.error("POST /v1/chat/completions supports messages, function tools/tool_calls, tool_choice, parallel_tool_calls, and buffered stream=true/false.");
  console.error("GET /v1/models exposes the compatibility model id 'pilink'; the actual model remains selected in the ChatGPT conversation.");
  console.error("Gateway mode never executes caller-advertised tools. The local agent harness owns permissions and execution.");
}
