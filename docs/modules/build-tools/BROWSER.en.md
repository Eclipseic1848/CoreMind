# Optional browser tools

Capability 07.04 covers reading page state, performing authorized actions, collecting evidence, and cancelling execution. Browser actions use Microsoft Playwright MCP through CoreMind's existing local stdio MCP transport, tool approval, and process cleanup. Code and command execution use this module's `ProcessRunner` and existing sandbox.

## Run the local example

Prepare the CoreMind source checkout, Node.js 22.19 or later, and a standalone Google Chrome installation. Run these commands from the repository root on Windows. On Linux, substitute the absolute path to the Chrome executable. The example pins `@playwright/mcp@0.0.81`, which uses `playwright` and `playwright-core` version `1.64.0-alpha-2026-09-14`. [Playwright MCP 0.0.81 release](https://github.com/microsoft/playwright-mcp/releases/tag/v0.0.81)

```powershell
npm run build
npm install --prefix .scratch/p2/browser-toolchain-81 --cache .scratch/p2/browser-toolchain-81/npm-cache --ignore-scripts --no-save --package-lock=false '@playwright/mcp@0.0.81'
node examples/modules/build-tools/browser/run.mjs .scratch/p2/browser-toolchain-81/node_modules/@playwright/mcp/package.json 'C:/Program Files/Google/Chrome/Application/chrome.exe'
```

The example listens on ephemeral `127.0.0.1` ports and uses a deterministic local model fixture. Chrome opens a synthetic report, enters a month, filters the report, checks the resulting page and screenshot, and downloads a synthetic CSV. The example then confirms that denied approval sends no navigation request, cancellation closes a pending browser request, and the cancelled run's MCP process and its directly launched Chrome process exit. An optional third argument names an existing evidence directory for `filtered.png`, `report.csv`, and `browser-result.json`.

## Connect a project

1. Follow the [example MCP configuration](../../../examples/modules/build-tools/browser/run.mjs). Set `transport: stdio`, configure absolute paths to Node and the verified `@playwright/mcp` entry point, and supply dedicated working and output directories. Set the browser executable explicitly and enable `--isolated`, `--headless`, and `--sandbox`. This launches an independent headless browser context without a user's signed-in state.
2. Declare only the reviewed tools for the intended agent. Treat browser sessions that navigate, click, download, or write screenshots as `external` with `reversible: false`, `replay: unknown`, and `durability: critical`. The example explicitly sets `mode: ask`, `workspaceOnly: false`, and `network: allow` for a trusted stdio host and individual action approvals. Projects can deploy a dedicated browser host under their own isolation controls.
3. Use only authorized web pages. `--allowed-origins` catches some unintended requests. Enforce redirect and network boundaries on the browser host. An isolated browser context controls session state. Use process, container, or firewall policies to restrict host file access and network egress. [Playwright MCP configuration boundaries](https://playwright.dev/mcp/configuration/options)
4. Review the destination, action, and data scope at approval. Confirm the resulting page state, download record, or file bytes. After an interruption, check the actual business state before retrying an action with possible side effects. Keep RunOutcome, Trace, and verified outputs.

In testing, `0.0.82` and `0.0.86` notified CoreMind of a tool catalog change after the first navigation, even with WebMCP disabled. CoreMind stops using the old catalog at that point, so the multi-step example pins `0.0.81`. Before upgrading, verify the catalog after first navigation and exercise the subsequent actions.
