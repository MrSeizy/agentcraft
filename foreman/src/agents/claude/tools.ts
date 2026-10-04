// Claude SDK adapter for the shared AgentCraft tools.
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { buildTeamTools, MCP_SERVER } from '../tools.js';
import { userName } from '../../user.js';
export * from '../tools.js';

export function buildMcpServer(...args: Parameters<typeof buildTeamTools>) {
  return createSdkMcpServer({ name: MCP_SERVER, version: '0.1.0', tools: buildTeamTools(...args), alwaysLoad: true, instructions: `AgentCraft team tools: coordinate with teammates, ask ${userName()}, keep memory and the task board up to date.` });
}
