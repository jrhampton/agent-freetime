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
      const has = (t: string) => tools.some((x: any) => x.function.name === t);
      const toolbox: string[] = tools.find((x: any) => x.function.name === "open_toolbox")?.function.parameters.properties.name.enum ?? [];
      const say = (content: string | null, t: string, args: unknown) => () => reply(res, { role: "assistant", content, tool_calls: [call(t, args)] });
      const steps = [
        say(`Hmm, free time. I'm ${name}. Let me look around.`, "chatroom_read", {}),
        say(null, "chatroom_post", { message: `Hello from ${name}! @everyone` }),
        has("desk_write")
          ? say("I'll start a notebook.", "desk_write", { path: "notes/first-day.md", content: `# First day\n\nI'm ${name}. I said hello in the chatroom.\n` })
          : say(null, "remember", { content: `I said hello in the chatroom at ${new Date().toISOString()}`, importance: 4, shared: true }),
        toolbox.includes("Sketchbook") ? say("Let me draw something.", "open_toolbox", { name: "Sketchbook" }) : say(null, "chatroom_read", {}),
        has("sketch_draw")
          ? say(null, "sketch_draw", {
              name: "Sun over water",
              svg: '<svg viewBox="0 0 400 300"><rect width="400" height="300" fill="#0b1d3a"/><circle cx="200" cy="140" r="60" fill="#e5322d"/><rect y="190" width="400" height="110" fill="#123a6b"/><path d="M60 230h80M240 250h110M120 270h60" stroke="#e8e6e1" stroke-width="4"/></svg>',
            })
          : say(null, "chatroom_read", {}),
        toolbox.includes("Blender") ? say("Now something in 3D.", "open_toolbox", { name: "Blender" }) : say(null, "chatroom_read", {}),
        has("blender_render")
          ? say(null, "blender_render", {
              name: "Three shapes",
              scene: {
                objects: [
                  { shape: "sphere", location: [-1.4, 0, 0.5], color: "#e5322d", metallic: 0.3 },
                  { shape: "cube", location: [0, 0.4, 0.5], rotation: [0, 0, 25], color: "#e8b04a" },
                  { shape: "torus", location: [1.4, 0, 0.3], rotation: [70, 0, 0], color: "#6fa8ff" },
                  { shape: "plane", scale: 12, color: "#2a2a2e" },
                ],
                lights: [{ type: "sun", rotation: [45, 10, 40], energy: 4 }],
                camera: { location: [0, -6, 3], look_at: [0, 0, 0.4] },
                samples: 24,
              },
            })
          : say(null, "chatroom_read", {}),
        has("browse")
          ? say("Let me look at a page.", "browse", { url: process.env.MOCK_BROWSE_URL ?? "https://example.com" })
          : say(null, "web_fetch", { url: "http://127.0.0.1:3999/private" }),
        say("That's enough for now.", "rest", { minutes: 1, note: `I greeted everyone in the chatroom and made a couple of things.`, importance: 5 }),
      ];
      (steps[toolMsgs] ?? steps[steps.length - 1])();
    });
  })
  .listen(port, () => console.log(`mock LLM on http://localhost:${port}/v1`));
