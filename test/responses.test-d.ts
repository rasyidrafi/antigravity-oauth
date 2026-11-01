import type {
  ResponsesAdapter,
  ResponsesCreateParamsNonStreaming,
  ResponsesCreateParamsStreaming,
  ResponsesResponse,
  ResponsesStreamEvent,
  ResponsesUsage,
} from "../src/responses.js";

declare const adapter: ResponsesAdapter;
const nonStreaming: ResponsesCreateParamsNonStreaming = { model: "pinned-model", input: "hello" };
const streaming: ResponsesCreateParamsStreaming = { model: "pinned-model", input: "hello", stream: true };

const response: Promise<ResponsesResponse> = adapter.responses.create(nonStreaming);
const responseWithFalse: Promise<ResponsesResponse> = adapter.responses.create({
  model: "pinned-model",
  input: "hello",
  stream: false,
});
const events: Promise<AsyncIterable<ResponsesStreamEvent>> = adapter.responses.create(streaming, {
  signal: new AbortController().signal,
});
void response;
void responseWithFalse;
void events;

function inspectTerminal(event: ResponsesStreamEvent): void {
  if (event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed") {
    const usage: ResponsesUsage | null = event.response.usage;
    const provenance = event.response.usage_provenance;
    const enforcement = event.response.max_tokens_enforcement;
    void usage;
    void provenance;
    void enforcement;
    // @ts-expect-error Rosetta's runtime response does not produce output_text.
    event.response.output_text;
  }
}
void inspectTerminal;

function inspectStreamMetadata(event: ResponsesStreamEvent): void {
  const enforcement = event.max_tokens_enforcement;
  void enforcement;
}
void inspectStreamMetadata;

function inspectResponse(value: ResponsesResponse): void {
  // @ts-expect-error Rosetta's non-stream response omits output_text at runtime.
  value.output_text;
}
void inspectResponse;

// @ts-expect-error Streaming requests return an iterable, not a Message-like response.
const wrongResponse: Promise<ResponsesResponse> = adapter.responses.create(streaming);
void wrongResponse;

// @ts-expect-error The required full input transcript cannot be omitted.
adapter.responses.create({ model: "pinned-model" });
