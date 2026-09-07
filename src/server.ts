import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadExecutionPolicy } from "./config.js";
import { ExecutionJournal } from "./execution-journal.js";
import { ExecutionPolicyGate } from "./execution-policy.js";
import { OrderExecutor } from "./order-executor.js";
import { Trading212Client } from "./trading212-client.js";
import { registerTrading212Tools } from "./tools.js";

const config = loadConfig(process.env);
const client = new Trading212Client(config);
const executionPolicy = loadExecutionPolicy(process.env);
const journal = executionPolicy.enabled ? new ExecutionJournal(executionPolicy.stateDir) : undefined;
const gate = new ExecutionPolicyGate(executionPolicy, client, journal);
const executor = new OrderExecutor(client, gate, journal);

const server = new McpServer(
  { name: "trading212-demo-execution", version: "2.0.0" },
  { instructions: "Trading 212 Invest practice-account tools. Mutation tools are permanently restricted to the demo API and require configured execution policy plus stable request IDs." },
);

registerTrading212Tools(server, client, executor);
await server.connect(new StdioServerTransport());
