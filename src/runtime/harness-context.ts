import type {Message} from '@deepseek-ai/dsh-llm';
import type {SessionEvent} from '@deepseek-ai/dsh-session';
import type {ToolDefinition} from '@deepseek-ai/dsh-tools';

/** Process-local fork point. Official JSONL owns replay; SQLite owns product evidence. */
export interface HarnessBranch {
  sessionId:string;
  system:string;
  events:readonly SessionEvent[];
  messages:readonly Message[];
  tools:ToolDefinition[];
}
