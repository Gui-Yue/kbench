import fs from 'fs';
import path from 'path';

import {
  type ContentBlock,
  type Message,
  type ModelProvider,
} from '@shareai-lab/kode-sdk';

import {
  GlmBenchFallbackProvider,
  RetryingProvider,
  createKodeProvider,
  describeError,
  parseModelName,
  readRetryConfig,
} from './shared/provider.js';

export interface KodeTauStepRunArgs {
  modelName: string;
  messagesFile: string;
  toolsFile: string;
  temperature?: number;
}

interface KodeTauStepCliArgs extends KodeTauStepRunArgs {
  outputPath: string;
}

export interface LegacyStepResult {
  ok: boolean;
  action?: {
    type: 'tool_call' | 'respond';
    tool_call?: {
      id: string;
      name: string;
      arguments: Record<string, any>;
    };
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: string;
}

function parseArgs(argv: string[]): KodeTauStepCliArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    values.set(key, next);
    i += 1;
  }

  const modelName = values.get('model-name');
  const messagesFile = values.get('messages-file');
  const toolsFile = values.get('tools-file');
  const outputPath = values.get('output');
  const temperatureValue = values.get('temperature');

  if (!modelName) throw new Error('Missing --model-name');
  if (!messagesFile) throw new Error('Missing --messages-file');
  if (!toolsFile) throw new Error('Missing --tools-file');
  if (!outputPath) throw new Error('Missing --output');

  return {
    modelName,
    messagesFile: path.resolve(messagesFile),
    toolsFile: path.resolve(toolsFile),
    outputPath: path.resolve(outputPath),
    temperature: temperatureValue ? Number(temperatureValue) : undefined,
  };
}

function loadJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function convertMessages(rawMessages: any[]): Message[] {
  return rawMessages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id || message.name || 'tool',
            content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
          },
        ],
      };
    }

    const content: ContentBlock[] = [];
    if (typeof message.content === 'string' && message.content) {
      content.push({ type: 'text', text: message.content });
    }

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        let input: any = {};
        const rawArguments = call?.function?.arguments;
        if (typeof rawArguments === 'string') {
          try {
            input = JSON.parse(rawArguments);
          } catch {
            input = { raw: rawArguments };
          }
        } else if (rawArguments && typeof rawArguments === 'object') {
          input = rawArguments;
        }
        content.push({
          type: 'tool_use',
          id: call?.id || `${call?.function?.name || 'tool'}-call`,
          name: call?.function?.name || 'tool',
          input,
        });
      }
    }

    return {
      role: message.role,
      content,
    };
  });
}

function convertTools(rawTools: any[]): any[] {
  return rawTools.map((tool) => ({
    name: tool?.function?.name || tool?.name,
    description: tool?.function?.description || tool?.description || '',
    input_schema: tool?.function?.parameters || tool?.input_schema || { type: 'object', properties: {} },
  }));
}

function ensureDirFor(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeResult(outputPath: string, result: LegacyStepResult): void {
  ensureDirFor(outputPath);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
}

function createRuntimeProvider(modelName: string): ModelProvider {
  const baseProvider = createKodeProvider(modelName);
  const reliableProvider = new RetryingProvider(baseProvider, readRetryConfig());
  return parseModelName(modelName).provider === 'glm'
    ? new GlmBenchFallbackProvider(reliableProvider)
    : reliableProvider;
}

export async function runKodeTauStep(args: KodeTauStepRunArgs): Promise<LegacyStepResult> {
  const rawMessages = loadJson(args.messagesFile);
  const rawTools = loadJson(args.toolsFile);
  const messages = convertMessages(rawMessages);
  const tools = convertTools(rawTools);

  const provider = createRuntimeProvider(args.modelName);

  try {
    const response = await provider.complete(messages, {
      tools,
      temperature: args.temperature,
    });

    const toolUse = response.content.find((block) => block.type === 'tool_use');
    if (toolUse && toolUse.type === 'tool_use') {
      return {
        ok: true,
        action: {
          type: 'tool_call',
          tool_call: {
            id: toolUse.id,
            name: toolUse.name,
            arguments: toolUse.input ?? {},
          },
        },
        usage: response.usage,
      };
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();

    if (!text) {
      throw new Error('Model response did not include a tool call or response text.');
    }

    return {
      ok: true,
      action: {
        type: 'respond',
        text,
      },
      usage: response.usage,
    };
  } catch (error) {
    return {
      ok: false,
      error: describeError(error),
    };
  }
}

export async function runKodeTauStepCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const result = await runKodeTauStep(args);
  writeResult(args.outputPath, result);
  process.exitCode = result.ok ? 0 : 1;
}
