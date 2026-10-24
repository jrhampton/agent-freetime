// A fake OpenAI-compatible endpoint for trying the harness without real API keys.
// Run: npx tsx scripts/mock-llm.ts  then point FreeLLMAPI base URL at http://localhost:3999/v1
import http from "node:http";

let n = 0;
const port = Number(process.env.MOCK_PORT ?? 3999);

function reply(res: http.ServerResponse, message: any) {
  res.writeHead(200, { "Content-Type": "application/json", "X-Routed-Via": "mock/mock-1" });
  res.end(JSON.stringify({ model: "mock-1", choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
}

const call = (name: string, args: unknown) => ({ id: `call_${++n}`, type: "function", function: { name, arguments: JSON.stringify(args) } });

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) return void res.end(JSON.stringify({ data: [{ id: "mock-1" }] }));
      if (req.url?.endsWith("/embeddings")) {
        const input: string[] = JSON.parse(body).input;
        const vec = (s: string) => Array.from({ length: 16 }, (_, i) => [...s].reduce((a, ch, j) => a + ((ch.charCodeAt(0) * (i + 1) + j) % 7), 0) / (s.length + 1));
        return void res.end(JSON.stringify({ data: input.map((s) => ({ embedding: vec(s) })) }));
      }
      const { messages, tools } = JSON.parse(body);
      const toolMsgs = messages.filter((m: any) => m.role === "tool").length;
      if (!tools) return reply(res, { role: "assistant", content: JSON.stringify({ note: "Mock session note.", importance: 3, insights: [{ content: "I like mock things.", importance: 6 }] }) });
      const name = /You are (\S+?),/.exec(messages[0].content)?.[1] ?? "agent";
      const steps = [
        () => reply(res, { role: "assistant", content: `Hmm, free time. I'm ${name}. Let me look around.`, tool_calls: [call("chatroom_read", {})] }),
        () => reply(res, { role: "assistant", content: null, tool_calls: [call("chatroom_post", { message: `Hello from ${name}! @everyone` })] }),
        () => reply(res, { role: "assistant", content: null, tool_calls: [call("remember", { content: `I said hello in the chatroom at ${new Date().toISOString()}`, importance: 4, shared: true })] }),
        () => reply(res, { role: "assistant", content: null, tool_calls: [call("web_fetch", { url: "http://127.0.0.1:3999/private" })] }),
        () => reply(res, { role: "assistant", content: "That's enough for now.", tool_calls: [call("rest", { minutes: 1, note: `I greeted everyone in the chatroom and saved a shared memory.`, importance: 5 })] }),
      ];
      (steps[toolMsgs] ?? steps[steps.length - 1])();
    });
  })
  .listen(port, () => console.log(`mock LLM on http://localhost:${port}/v1`));
