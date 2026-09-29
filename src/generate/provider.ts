import { EngineConfig, Generation, LlmProvider, ProviderMessage } from '../types';

/* ------------------------------------------------------------------ providers */

/** Fully local. This is the "inbuilt engine" default — no code leaves the host. */
class OllamaProvider implements LlmProvider {
  readonly name: string;
  constructor(private model: string, private baseUrl: string) {
    this.name = `ollama:${model}`;
  }
  async complete(args: {
    system: string;
    messages: ProviderMessage[];
    maxTokens: number;
    temperature: number;
  }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [{ role: 'system', content: args.system }, ...args.messages],
        options: { temperature: args.temperature, num_predict: args.maxTokens, num_ctx: 16384 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { message?: { content?: string } };
    return body.message?.content ?? '';
  }
}

/** OpenAI-compatible: vLLM, LM Studio, TGI, Azure OpenAI, on-prem gateways. */
class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  constructor(private model: string, private baseUrl: string, private apiKey: string) {
    this.name = `openai-compatible:${model}`;
  }
  async complete(args: {
    system: string;
    messages: ProviderMessage[];
    maxTokens: number;
    temperature: number;
  }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        temperature: args.temperature,
        max_tokens: args.maxTokens,
        messages: [{ role: 'system', content: args.system }, ...args.messages],
      }),
    });
    if (!res.ok) throw new Error(`LLM gateway ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? '';
  }
}

class AnthropicProvider implements LlmProvider {
  readonly name: string;
  constructor(private model: string, private apiKey: string, private baseUrl: string) {
    this.name = `anthropic:${model}`;
  }
  async complete(args: {
    system: string;
    messages: ProviderMessage[];
    maxTokens: number;
    temperature: number;
  }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: args.maxTokens,
        temperature: args.temperature,
        system: args.system,
        messages: args.messages,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (body.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
  }
}

export function createProvider(config: EngineConfig): LlmProvider {
  const p = config.provider;
  const key = p.apiKeyEnv ? process.env[p.apiKeyEnv] ?? '' : '';
  switch (p.kind) {
    case 'builtin':
      // Never called — runTasks short-circuits to the synthesiser. Present so
      // that provider.name still reads correctly in logs and the report.
      return {
        name: 'builtin (no model)',
        async complete() {
          throw new Error('builtin provider is synthesised, not prompted');
        },
      };
    case 'ollama':
      return new OllamaProvider(p.model, p.baseUrl ?? 'http://127.0.0.1:11434');
    case 'openai-compatible':
      return new OpenAICompatibleProvider(p.model, p.baseUrl ?? '', key);
    case 'anthropic':
      return new AnthropicProvider(p.model, key, p.baseUrl ?? 'https://api.anthropic.com');
    case 'bedrock':
      // Bedrock needs SigV4; keep it out of the POC dependency tree. Point an
      // OpenAI-compatible gateway (e.g. LiteLLM) at Bedrock instead.
      throw new Error(
        'bedrock: use provider.kind="openai-compatible" behind a LiteLLM/Bedrock gateway for the POC.'
      );
    default:
      throw new Error(`Unknown provider kind: ${String(p.kind)}`);
  }
}

/* -------------------------------------------------------------------- parsing */

const TEST_FILE_RE = /<test-file\s+path="([^"]+)"\s*>\n?([\s\S]*?)<\/test-file>/;
const PATCH_RE = /<patch\s+path="([^"]+)"\s*>\n?([\s\S]*?)<\/patch>/g;
const RATIONALE_RE = /<rationale>\n?([\s\S]*?)<\/rationale>/;
const SR_RE = /<<<<<<<\s*SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>>\s*REPLACE/g;

/** Strip a stray markdown fence the model may wrap the file in. */
function unfence(s: string): string {
  const m = /^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(s);
  return (m ? m[1] : s).replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
}

export function parseGeneration(taskId: string, raw: string): Generation {
  const testMatch = TEST_FILE_RE.exec(raw);
  const edits: Generation['edits'] = [];

  PATCH_RE.lastIndex = 0;
  let patchMatch: RegExpExecArray | null;
  while ((patchMatch = PATCH_RE.exec(raw)) !== null) {
    const filePath = patchMatch[1];
    const inner = patchMatch[2];
    SR_RE.lastIndex = 0;
    let sr: RegExpExecArray | null;
    while ((sr = SR_RE.exec(inner)) !== null) {
      edits.push({ path: filePath, search: sr[1], replace: sr[2] });
    }
  }

  return {
    taskId,
    testFile: testMatch ? { path: testMatch[1], contents: unfence(testMatch[2]) } : null,
    edits,
    rationale: RATIONALE_RE.exec(raw)?.[1].trim() ?? '',
    raw,
  };
}
