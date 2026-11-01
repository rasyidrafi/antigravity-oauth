import type { Session } from "../src/index.js";
import { createChatAdapter } from "../src/chat.js";
import type {
  ChatCompletionRequestOptions,
  ChatCompletionResponse,
  ChatCompletionStreamChunk,
} from "../src/chat.js";
import * as sdk from "../src/index.js";

declare const session: Session;
declare const signal: AbortSignal;

const chat = createChatAdapter(session);
const nonStreaming: Promise<ChatCompletionResponse> = chat.completions.create({
  model: session.configuration.model,
  messages: [{ role: "user", content: "hello" }],
});
const streaming: Promise<AsyncIterable<ChatCompletionStreamChunk>> = chat.completions.create({
  model: session.configuration.model,
  messages: [{ role: "user", content: "hello" }],
  stream: true,
  stream_options: { include_usage: true },
}, { signal });
const options: ChatCompletionRequestOptions = { signal };
const enforcement: ChatCompletionResponse["max_tokens_enforcement"] = {
  accountId: "acct_1",
  sessionId: "sess_1",
  operationId: "op_1",
  kind: "prompt",
  requestedMaxTokens: 1,
  policy: "allow-unenforced-max-tokens",
  outcome: "not-enforced",
  reason: "backend-does-not-enforce-requested-bound",
};
void nonStreaming;
void streaming;
void options;
void enforcement;

async function inspectChunk(): Promise<void> {
  const chunks = await streaming;
  for await (const chunk of chunks) {
    const receipt = chunk.max_tokens_enforcement;
    void receipt;
  }
}
void inspectChunk;

// @ts-expect-error the optional adapter is intentionally not exported from the SDK root.
sdk.createChatAdapter;
