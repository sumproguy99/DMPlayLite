// Built-in AI assistant (Claude API).
//   draft(text) → a workflow JSON for the user to review in the builder (nothing is saved)
//   ask(text)   → does what you asked using Playlite's tools, replies in a sentence (used by Siri / the UI)
import Anthropic from '@anthropic-ai/sdk';
import { WORKFLOW_GUIDE, callTool, normalizeWorkflow } from './tools.js';

const DEFAULT_MODEL = 'claude-opus-5-5';
const READ_ONLY = new Set(['list_lights', 'list_workflows', 'get_workflow', 'list_network_devices', 'home_assistant_entities', 'recent_activity']);

export class Assistant {
  constructor({ getConfig, tools, log }) {
    this.getConfig = getConfig;
    this.tools = tools;
    this.log = log;
  }

  get apiKey() { return process.env.ANTHROPIC_API_KEY || this.getConfig().ai?.apiKey || ''; }
  get ready() { return Boolean(this.apiKey); }
  get model() { return this.getConfig().ai?.model || DEFAULT_MODEL; }

  #context() {
    const c = this.getConfig();
    return [
      `Now: ${new Date().toString()}.`,
      c.location?.lat ? `Home location: ${c.location.name ?? ''} (${c.location.lat}, ${c.location.lon}).` : 'Home location not set (sun/dark conditions need it).',
      `Groups: ${c.groups.map((g) => `${g.name} = group:${g.id}`).join(', ') || 'none'}.`,
      `Existing workflows: ${c.routines.map((r) => r.name).join('; ') || 'none'}.`,
    ].join('\n');
  }

  async #loop({ system, messages, toolDefs, effort, onTool, maxTurns = 8 }) {
    const client = new Anthropic({ apiKey: this.apiKey });
    const params = {
      model: this.model,
      max_tokens: 16000,
      system,
      tools: toolDefs,
      output_config: { effort },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    };
    for (let turn = 0; turn < maxTurns; turn++) {
      let response;
      try {
        response = await client.beta.messages.create({ ...params, messages });
      } catch (err) {
        if (err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message) && params.fallbacks) {
          delete params.fallbacks;
          delete params.betas;
          response = await client.beta.messages.create({ ...params, messages });
        } else throw friendly(err);
      }
      if (response.stop_reason === 'refusal') throw new Error("The assistant declined that request.");
      messages.push({ role: 'assistant', content: response.content });
      const uses = response.content.filter((b) => b.type === 'tool_use');
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (response.stop_reason !== 'tool_use' || !uses.length) return { text, done: false };

      const results = [];
      let stop = null;
      for (const use of uses) {
        try {
          const out = await onTool(use.name, use.input);
          if (out?.stop) stop = out;
          const { image, ...rest } = out?.result ?? out ?? {};
          const json = JSON.stringify(out?.result ?? out ?? null).slice(0, 20_000);
          // a camera snapshot goes to Claude as a real image it can look at
          const content = image ? [{ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }, { type: 'text', text: JSON.stringify(rest) }] : json;
          results.push({ type: 'tool_result', tool_use_id: use.id, content });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: use.id, content: `Error: ${err.message}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
      if (stop) return { ...stop, text };
    }
    return { text: 'I ran out of steps — try a simpler request.', done: false };
  }

  #defs(filter) {
    return this.tools.filter((t) => filter(t.name)).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }

  async draft(idea) {
    if (!this.ready) throw new Error('Add a Claude API key under Connections → AI to use this.');
    const propose = {
      name: 'propose_workflow',
      description: `Return the finished workflow for the user to review. Call this exactly once when ready.\n\n${WORKFLOW_GUIDE}`,
      input_schema: {
        type: 'object',
        properties: { workflow: { type: 'object' }, summary: { type: 'string', description: 'One sentence: what it does, plus anything the user must set up.' } },
        required: ['workflow', 'summary'],
        additionalProperties: false,
      },
    };
    const system = `You turn a home-automation idea into a Playlite workflow. Look up real light ids, device names and Home Assistant entities with the tools before deciding; never invent ids. Prefer Playlite groups as targets. If something can't be expressed, pick the closest workflow and say what's missing in the summary. Finish by calling propose_workflow.\n\n${this.#context()}\n\n${WORKFLOW_GUIDE}`;
    const result = await this.#loop({
      system,
      messages: [{ role: 'user', content: idea }],
      toolDefs: [...this.#defs((n) => READ_ONLY.has(n)), propose],
      effort: 'medium',
      onTool: async (name, input) => {
        if (name === 'propose_workflow') {
          const workflow = normalizeWorkflow({ ...input.workflow, enabled: input.workflow.enabled ?? true });
          return { stop: true, done: true, workflow, summary: input.summary, result: { ok: true } };
        }
        return callTool(this.tools, name, input);
      },
    });
    if (!result.done) throw new Error(result.text || "Couldn't build a workflow from that — try rephrasing.");
    this.log.info(`AI drafted workflow "${result.workflow.name}"`);
    return { workflow: result.workflow, summary: result.summary };
  }

  async ask(question) {
    if (!this.ready) return 'Playlite needs a Claude API key before I can answer. Add one under Connections, AI.';
    const system = `You are Playlite, a home automation assistant. Do what the user asks using the tools, then reply in one or two short spoken-style sentences (your reply may be read aloud by Siri). Look up ids with list_lights / list_workflows first; never invent them.\n\n${this.#context()}`;
    const { text } = await this.#loop({
      system,
      messages: [{ role: 'user', content: question }],
      toolDefs: this.#defs(() => true),
      effort: 'low',
      onTool: (name, input) => callTool(this.tools, name, input),
    });
    this.log.info(`AI: "${question}" → ${text.slice(0, 120)}`);
    return text || 'Done.';
  }
}

function friendly(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error('The Claude API key was rejected — check it under Connections → AI.');
  if (err instanceof Anthropic.RateLimitError) return new Error('Claude is rate-limited right now — try again in a minute.');
  if (err instanceof Anthropic.APIConnectionError) return new Error("Couldn't reach the Claude API — is this PC online?");
  if (err instanceof Anthropic.APIError) return new Error(`Claude API error ${err.status}: ${err.message}`);
  return err;
}
