import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, {
  type AgentHandle,
  type AgentSetup
} from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, {
  LlmAdapter,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk
} from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId, type SessionId as SessionIdValue } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools';

export const TEST_PROVIDER = 'release-contract-provider';
export const TEST_MODEL = 'release-contract-model';
export const COMPANION_MARKER = 'release-runtime-marker';
export const COMPANION_PERSONA = 'Release contract companion persona.';
export const COMPANION_TOOL = 'companion_allowed';
export const OTHER_TOOL = 'unrelated_only';

export type ToolCounters = {
  [COMPANION_TOOL]: number;
  [OTHER_TOOL]: number;
};

export interface AgentRuntime {
  readonly root: Context;
  readonly adapter: CapturingLlmAdapter;
  sessionId(id: string): SessionIdValue;
  createAgent(id: string, setup?: AgentSetup): Promise<AgentHandle>;
  dispose(): Promise<void>;
}

type DisposableFiber = {
  dispose(): Promise<void> | void;
};

export class CapturingLlmAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Release contract fixture adapter' };
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Release contract fixture model',
      inputModalities: ['text']
    });
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const block: ContentBlock = { type: 'text', text: 'Fixed contract response.' };
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: block.text };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export async function createAgentRuntime(): Promise<AgentRuntime> {
  const root = new Context();
  const adapter = new CapturingLlmAdapter();
  const fibers: DisposableFiber[] = [];
  const handles: AgentHandle[] = [];
  let disposed = false;
  let adapterDispose: (() => void) | undefined;

  async function mount(plugin: unknown, config?: unknown): Promise<void> {
    const fiber = await root.plugin(plugin as never, config as never);
    fibers.push(fiber);
  }

  try {
    await mount(SystemPrompt, {
      includeHarnessIdentity: false,
      personaPrefix: 'Release contract deployment.'
    });
    await mount(AgentRegistry);
    await mount(SessionStore);
    await mount(LlmRuntime);
    await mount(SessionProjectionRegistry);
    await mount(ToolRuntime);
    await mount(AgentLoop, {
      agents: [],
      maxParallelToolCalls: 10
    });
    adapterDispose = root.llm.registerAdapter([TEST_PROVIDER], adapter);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const fiber of fibers.toReversed()) {
      try {
        await fiber.dispose();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Agent runtime setup and rollback failed'
      );
    }
    throw error;
  }

  const sessionId = (id: string) => SessionId(id);

  return {
    root,
    adapter,
    sessionId,
    async createAgent(id, setup) {
      const handle = await root.agents.create({
        sessionId: sessionId(id),
        agentOptions: {
          provider: TEST_PROVIDER,
          model: TEST_MODEL
        },
        setup
      });
      handles.push(handle);
      return handle;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;

      const cleanupErrors: unknown[] = [];
      for (const handle of handles.toReversed()) {
        try {
          await handle.dispose();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        adapterDispose?.();
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const fiber of fibers.toReversed()) {
        try {
          await fiber.dispose();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      handles.length = 0;
      fibers.length = 0;

      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Agent runtime disposal failed');
      }
    }
  };
}

export function registerFixtureTools(root: Context): ToolCounters {
  const counters: ToolCounters = {
    [COMPANION_TOOL]: 0,
    [OTHER_TOOL]: 0
  };

  for (const name of [COMPANION_TOOL, OTHER_TOOL] as const) {
    root.tools.register({
      name,
      description: `Contract fixture tool ${name}.`,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            calls: { type: 'integer' }
          },
          required: ['calls'],
          additionalProperties: false
        },
        render(_args, value): ContentBlock[] {
          const calls = value as { calls: number };
          return [{ type: 'text', text: `${name}:${calls.calls}` }];
        }
      },
      async execute(): Promise<{ calls: number }> {
        counters[name] += 1;
        return { calls: counters[name] };
      }
    });
  }

  return counters;
}

export function executeFixtureTool(
  root: Context,
  agent: Parameters<typeof root.tools.execute>[0]['agent'],
  name: string,
  callId: string
): Promise<ToolExecutionResult> {
  return root.tools.execute({
    callId: ToolCallId(callId),
    name,
    arguments: {},
    agent,
    signal: new AbortController().signal
  });
}
