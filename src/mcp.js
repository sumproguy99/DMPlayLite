// Model Context Protocol server over Streamable HTTP (JSON responses, no server-initiated streams).
// Lets Claude Desktop / Claude Code / any MCP client control Playlite:
//   claude mcp add --transport http playlite "http://<pc>:8787/mcp?key=<key>"
import { callTool } from './tools.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export async function handleMcp(message, tools) {
  if (Array.isArray(message)) {
    const out = (await Promise.all(message.map((m) => handleMcp(m, tools)))).filter(Boolean);
    return out.length ? out : null;
  }
  const { id, method, params } = message ?? {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });
  if (id === undefined) return null; // notification (e.g. notifications/initialized)

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'playlite', version: '0.2.0' },
        instructions: 'Playlite is a home automation hub (lights, Plex, network presence, Home Assistant). Use list_lights and list_workflows before changing things.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call':
      try {
        const result = await callTool(tools, params?.name, params?.arguments);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}
