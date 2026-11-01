import type { Session } from "../src/index.js";
import { createChatAdapter } from "../src/chat.js";
import { createResponsesAdapter } from "../src/responses.js";

declare const session: Session;
declare const signal: AbortSignal;

// Chat example from README.md: fixed system pin plus the complete committed
// transcript are resubmitted for the stream follow-up.
const chat = createChatAdapter(session);
const system = { role: "system" as const, content: "Use the pinned instructions." };
const firstUser = { role: "user" as const, content: "Hello" };
const completion = await chat.completions.create({
  model: session.configuration.model,
  messages: [system, firstUser],
});
const assistantMessage = completion.choices[0]?.message;
if (!assistantMessage || typeof assistantMessage.content !== "string") {
  throw new Error("The example expects a text-only Chat response.");
}
const assistantTurn = { role: "assistant" as const, content: assistantMessage.content };
const chatStream = await chat.completions.create({
  model: session.configuration.model,
  messages: [system, firstUser, assistantTurn, { role: "user" as const, content: "Continue" }],
  stream: true,
  stream_options: { include_usage: true },
});
void chatStream;

// Responses example from README.md: narrow output-only unions to a completed
// text message, then reconstruct a valid text-only ResponseInputItem.
const responses = createResponsesAdapter(session);
const instructions = "Use the pinned instructions.";
const result = await responses.responses.create({
  model: session.configuration.model,
  instructions,
  input: "Hello",
  max_output_tokens: 512,
});
const [assistantOutput] = result.output;
if (!assistantOutput || assistantOutput.type !== "message" || assistantOutput.status !== "completed") {
  throw new Error("The example expects one text-message Responses output.");
}
const assistantTextParts = assistantOutput.content.filter(
  (part): part is Extract<(typeof assistantOutput.content)[number], { type: "output_text" }> =>
    part.type === "output_text",
);
if (assistantTextParts.length !== assistantOutput.content.length) {
  throw new Error("The example expects text-only assistant output.");
}
if (assistantTextParts.some((part) => part.annotations.length !== 0 || (part.logprobs?.length ?? 0) !== 0)) {
  throw new Error("The example expects unannotated text output.");
}
const assistantInput = {
  type: "message" as const,
  id: assistantOutput.id,
  role: "assistant" as const,
  status: assistantOutput.status,
  content: assistantTextParts.map(({ text }) => ({
    type: "output_text" as const,
    text,
    annotations: [],
  })),
};
const responseStream = await responses.responses.create({
  model: session.configuration.model,
  instructions,
  input: [
    { type: "message", role: "user", content: "Hello" },
    assistantInput,
    { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
  ],
  stream: true,
}, { signal });
void responseStream;
