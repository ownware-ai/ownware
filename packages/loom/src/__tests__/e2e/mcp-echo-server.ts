/**
 * Minimal MCP Echo Server for E2E Testing
 *
 * A simple stdio MCP server that:
 * - Responds to initialization
 * - Exposes 3 tools: echo, reverse, uppercase (with annotations)
 * - Exposes 1 resource: test://greeting
 * - Handles tool calls by echoing/transforming input
 *
 * Run directly: npx tsx src/__tests__/e2e/mcp-echo-server.ts
 */

import { createInterface } from 'node:readline'

const rl = createInterface({ input: process.stdin })

function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function handleRequest(request: any): void {
  const { id, method, params } = request

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
          },
          serverInfo: { name: 'echo-server', version: '1.0.0' },
        },
      })
      break

    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo back the input message',
              inputSchema: {
                type: 'object',
                properties: {
                  message: { type: 'string', description: 'Message to echo' },
                },
                required: ['message'],
              },
              annotations: { readOnlyHint: true },
            },
            {
              name: 'reverse',
              description: 'Reverse the input string',
              inputSchema: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'Text to reverse' },
                },
                required: ['text'],
              },
              annotations: { readOnlyHint: true },
            },
            {
              name: 'uppercase',
              description: 'Convert text to uppercase (modifying operation)',
              inputSchema: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'Text to uppercase' },
                },
                required: ['text'],
              },
              annotations: { destructiveHint: true },
            },
          ],
        },
      })
      break

    case 'resources/list':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          resources: [
            {
              uri: 'test://greeting',
              name: 'Greeting',
              description: 'A test greeting resource',
              mimeType: 'text/plain',
            },
            {
              uri: 'test://config',
              name: 'Config',
              description: 'Server configuration',
              mimeType: 'application/json',
            },
          ],
        },
      })
      break

    case 'resources/read': {
      const uri = params?.uri as string
      if (uri === 'test://greeting') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              { uri: 'test://greeting', mimeType: 'text/plain', text: 'Hello from Echo Server!' },
            ],
          },
        })
      } else if (uri === 'test://config') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              { uri: 'test://config', mimeType: 'application/json', text: '{"version":"1.0","mode":"test"}' },
            ],
          },
        })
      } else {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown resource: ${uri}` },
        })
      }
      break
    }

    case 'tools/call': {
      const toolName = params?.name as string
      const args = params?.arguments as Record<string, unknown>

      switch (toolName) {
        case 'echo':
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: String(args.message ?? '') }],
            },
          })
          break
        case 'reverse':
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: String(args.text ?? '').split('').reverse().join('') }],
            },
          })
          break
        case 'uppercase':
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: String(args.text ?? '').toUpperCase() }],
            },
          })
          break
        default:
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
              isError: true,
            },
          })
      }
      break
    }

    case 'notifications/initialized':
      // Notification — no response needed
      break

    default:
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      })
  }
}

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  try {
    const msg = JSON.parse(trimmed)
    handleRequest(msg)
  } catch {
    // Ignore non-JSON lines
  }
})
