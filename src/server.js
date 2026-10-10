import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { inputSchema } from "./schema.js";
import { inspect } from "./service.js";
const server = new McpServer({ name: "ci-errors-mcp", version: "0.1.0" });
server.registerTool(
  "ci_errors",
  {
    description:
      "Read GitHub Actions CI errors without modifying anything. Provide a run_url, repository+run_id, or absolute repo_path to inspect runs for current local HEAD only. Specify attempt or a /attempts/N run URL to read a particular attempt; otherwise reads the latest attempt. Returns a single JSON text report with original error blocks, expected/actual values when logged, and file/line/column positions labelled test_definition, throw_site, stack or diagnostic. Positions are reported evidence, not inferred root causes. No matching run is not_found, not success. For hasMore=true call this same tool with cursor; partial=true means an error block continues. gh CLI must be installed and authenticated. No chat history is required.",
    inputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (input) => {
    try {
      const result = await inspect(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  },
);
await server.connect(new StdioServerTransport());
