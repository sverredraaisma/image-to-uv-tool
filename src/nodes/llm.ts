// OpenRouter LLM nodes. Each takes an optional wired text input plus a prompt
// typed on the node, and outputs text. Manual-run so tokens aren't spent
// automatically.

import type { NodeDefinition } from '../types';
import { chatCompletion, type ChatMessage } from '../lib/openrouter';
import { asText, num, str } from './helpers';

interface LlmSpec {
  type: string;
  label: string;
  description: string;
  model: string;
}

function makeLlmNode(spec: LlmSpec): NodeDefinition {
  return {
    type: spec.type,
    label: spec.label,
    category: 'AI (OpenRouter)',
    description: spec.description,
    autoRun: false,
    inputs: [{ id: 'text', label: 'Text', type: 'text' }],
    outputs: [{ id: 'out', label: 'Text', type: 'text' }],
    configFields: [
      { kind: 'text', key: 'model', label: 'Model', advanced: true },
      { kind: 'text', key: 'prompt', label: 'Prompt', multiline: true, placeholder: 'Instruction; wired text is appended' },
      { kind: 'text', key: 'system', label: 'System prompt', multiline: true, advanced: true },
      { kind: 'number', key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.1, advanced: true },
      { kind: 'number', key: 'maxTokens', label: 'Max tokens', min: 1, step: 1, advanced: true },
    ],
    defaultConfig: () => ({ model: spec.model, prompt: '', system: '', temperature: 0.7, maxTokens: 1024 }),
    compute: async ({ inputs, config, openRouterKey, signal, onProgress }) => {
      if (!openRouterKey) throw new Error('Set your OpenRouter API key first');
      const wired = asText(inputs.text) ?? '';
      const prompt = str(config.prompt);
      const userContent = [prompt, wired].filter(Boolean).join('\n\n');
      if (!userContent) throw new Error('Provide a prompt or connect a text input');

      const messages: ChatMessage[] = [];
      const system = str(config.system);
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: userContent });

      onProgress?.('Calling model…');
      const text = await chatCompletion(str(config.model, spec.model), messages, {
        apiKey: openRouterKey,
        signal,
        temperature: num(config.temperature, 0.7),
        maxTokens: num(config.maxTokens, 1024),
      });
      return { out: { kind: 'text', text } };
    },
  };
}

export const llmNodes: NodeDefinition[] = [
  makeLlmNode({
    type: 'llmLlama8b',
    label: 'Llama 3.1 8B',
    description: 'Lightweight Llama 3.1 8B Instruct via OpenRouter.',
    model: 'meta-llama/llama-3.1-8b-instruct',
  }),
  makeLlmNode({
    type: 'llmGeminiFlash',
    label: 'Gemini Flash',
    description: 'Fast, cheap Google Gemini Flash via OpenRouter.',
    model: 'google/gemini-2.0-flash-001',
  }),
  makeLlmNode({
    type: 'llmGpt4oMini',
    label: 'GPT-4o mini',
    description: 'OpenAI GPT-4o mini via OpenRouter.',
    model: 'openai/gpt-4o-mini',
  }),
  makeLlmNode({
    type: 'llmCustom',
    label: 'OpenRouter (custom)',
    description: 'Any OpenRouter model — set the slug and a prompt.',
    model: 'meta-llama/llama-3.1-8b-instruct',
  }),
];
