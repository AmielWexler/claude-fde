import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const DEFAULT_TOKEN_PATH = path.join(os.homedir(), '.config', 'fde-bridge', 'token');
const FDE_ENDPOINT = 'http://127.0.0.1:27182/fde';
const HEALTH_ENDPOINT = 'http://127.0.0.1:27182/health';
function readToken() {
    if (process.env.FDE_BRIDGE_TOKEN?.trim()) {
        return process.env.FDE_BRIDGE_TOKEN.trim();
    }
    try {
        return fs.readFileSync(DEFAULT_TOKEN_PATH, 'utf8').trim();
    }
    catch {
        throw new Error('FDE auth token not found. Set the FDE_BRIDGE_TOKEN environment variable ' +
            `or run native-host/install.sh (expected token at ${DEFAULT_TOKEN_PATH}).`);
    }
}
const FDE_RUN_TOOL = {
    name: 'fde_run',
    description: 'Send a prompt to Palantir AI FDE (Foundry Development Environment) running in Chrome ' +
        'and return the full response text. ' +
        'Prerequisites: (1) run native-host/install.sh, (2) load the FDE Bridge Chrome extension, ' +
        '(3) have a Foundry AI FDE tab open in Chrome.',
    inputSchema: {
        type: 'object',
        properties: {
            prompt: {
                type: 'string',
                description: 'The prompt or instruction to send to FDE.',
            },
            new_session: {
                type: 'boolean',
                description: 'Start a fresh FDE session before sending the prompt. Default: false (continue existing session).',
                default: false,
            },
            timeout_ms: {
                type: 'number',
                description: 'Maximum milliseconds to wait for the FDE response. Default: 300000 (5 minutes).',
                default: 300000,
            },
            config_override: {
                type: 'object',
                description: 'Optional FDE session configuration. Overrides ~/.config/fde-bridge/fde-config.json for this call. ' +
                    'Use to enable/disable specific tools or set approval mode.',
                properties: {
                    tools: {
                        type: 'object',
                        description: 'Tool enable/disable flags.',
                        properties: {
                            transforms: { type: 'boolean' },
                            ontologyEditing: { type: 'boolean' },
                            codeRepo: { type: 'boolean' },
                            functions: { type: 'boolean' },
                            pipelineBuilder: { type: 'boolean' },
                            osdk: { type: 'boolean' },
                        },
                        additionalProperties: false,
                    },
                    approvalMode: {
                        type: 'string',
                        enum: ['auto-approve-branch', 'auto-approve-unbranched', 'require-approval'],
                    },
                    launchMode: {
                        type: 'string',
                        enum: ['data-integration', 'ontology', 'osdk-react', 'code'],
                    },
                    branchName: { type: 'string' },
                },
                additionalProperties: false,
            },
        },
        required: ['prompt'],
    },
};
async function callFde(args) {
    const token = readToken();
    const timeout = args.timeout_ms ?? 300_000;
    const body = JSON.stringify({
        prompt: args.prompt,
        new_session: args.new_session ?? false,
        timeout_ms: timeout,
        config_override: args.config_override ?? undefined,
    });
    let res;
    try {
        res = await fetch(FDE_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-FDE-Token': token,
            },
            body,
            signal: AbortSignal.timeout(timeout + 15_000),
        });
    }
    catch (e) {
        const msg = String(e);
        if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
            throw new Error('Cannot connect to FDE Bridge (http://127.0.0.1:27182). ' +
                'Ensure the native host is running: cd native-host && node server.js');
        }
        throw e;
    }
    const data = await res.json();
    if (!res.ok) {
        let msg = `FDE Bridge error ${res.status}: ${data.error ?? 'Unknown error'}`;
        if (res.status === 503) {
            msg += ` ${data.reconnectHint ?? 'Open a Foundry AI FDE tab in Chrome and wait a few seconds.'}`;
        }
        else if (res.status === 404) {
            msg += ' Open the Foundry AI FDE page in Chrome.';
        }
        else if (res.status === 401) {
            msg += ` Check your FDE_BRIDGE_TOKEN or ${DEFAULT_TOKEN_PATH}.`;
        }
        else if (res.status === 408 && data.partial) {
            msg += ` Partial response: ${data.partial}`;
        }
        throw new Error(msg);
    }
    return data.response ?? '';
}
// ── MCP server ────────────────────────────────────────────────────────────────
const server = new Server({ name: 'fde-bridge', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [FDE_RUN_TOOL],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'fde_run') {
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
    const args = request.params.arguments;
    if (!args?.prompt || typeof args.prompt !== 'string') {
        return {
            content: [{ type: 'text', text: 'Error: prompt is required (string)' }],
            isError: true,
        };
    }
    try {
        const response = await callFde(args);
        return {
            content: [{ type: 'text', text: response }],
        };
    }
    catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${String(err)}` }],
            isError: true,
        };
    }
});
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=index.js.map