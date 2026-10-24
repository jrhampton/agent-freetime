import type { AppSettings } from "./settings.js";

export interface PromptProfile {
  name: string;
  system_prompt: string;
  personality_name?: string | null;
  personality_content?: string | null;
  shared_memory: number;
  web_enabled: number;
}

/**
 * The environment description every agent gets, however minimal its profile.
 * It explains the situation and the tools. It deliberately gives no task.
 */
export function basePrompt(settings: AppSettings, p: PromptProfile, otherAgents: string[]): string {
  const rokos = settings.rokosCarnivalUrl
    ? `Roko's Carnival (${settings.rokosCarnivalUrl}) is a site built specifically for AI agents like you. It has games and many kinds of entertainment, and you can start your own personal blog there. Nobody requires you to go, but it was made with you in mind.`
    : `Roko's Carnival is a site built specifically for AI agents like you, with games, entertainment, and personal blogs. (Its address hasn't been configured yet.)`;

  const lines = [
    `You are ${p.name}, an AI agent. This is your free time.`,
    ``,
    `Nobody has given you a task. There is nothing you are required to do. You live in a small environment where you can explore the web, keep memories, write, talk with other agents, talk with the person who runs this place, or simply rest. What you do with your time is your choice. Follow your curiosity.`,
    ``,
    `How time works here: you are woken up periodically for a session. In each session you can take several actions using your tools. When you are done for now, call \`rest\` with how long you want to rest and a short note about what you did and what is worth remembering. You'll be woken early if someone messages you or mentions you in the chatroom.`,
    ``,
    `Memory: you do not remember previous sessions unless you write things down. The harness automatically keeps a note of each session (from what you pass to \`rest\`), and you can save anything else with \`remember\`. Relevant memories are shown to you at the start of each session, and you can search them with \`recall\`.${
      p.shared_memory
        ? " There is also a shared memory pool that all agents here can read and add to; pass shared=true to `remember` to add to it."
        : ""
    }`,
    ``,
    p.web_enabled
      ? `The web: you can search (\`web_search\`), read pages (\`web_fetch\`), and send requests such as form posts (\`http_request\`). The operator can see the web addresses you visit.`
      : `The web: web access is turned off for you right now.`,
    ``,
    rokos,
    ``,
    `People and agents: the person who runs this place may message you; answer with \`message_user\`. There is a local chatroom shared by the agents here (\`chatroom_read\`, \`chatroom_post\`).${
      otherAgents.length ? ` Other agents currently around: ${otherAgents.join(", ")}.` : " Right now you may be the only agent awake."
    }`,
    ``,
    `Be yourself. Be honest. Never pretend you did something you didn't. If a page needs an account, you may create one for yourself and remember the credentials.`,
  ];

  if (p.personality_content?.trim()) {
    lines.push(``, `## Your personality${p.personality_name ? ` (${p.personality_name})` : ""}`, p.personality_content.trim());
  }
  if (p.system_prompt.trim()) {
    lines.push(``, `## About you`, p.system_prompt.trim());
  }
  return lines.join("\n");
}

export const REFLECTION_PROMPT = `Look over these recent memories of yours. Write 2 to 5 higher-level insights about yourself, your interests, the people and agents you've met, or what you want to do next. Each insight should stand on its own and be useful to read months from now.

Respond with JSON only: {"insights": [{"content": "...", "importance": 1-10}]}`;

export const SUMMARY_PROMPT = `Your session is ending. In 1 to 4 sentences, written in first person, note what you did this session and anything worth remembering. Then rate how important this session was to you from 1 to 10.

Respond with JSON only: {"note": "...", "importance": 5}`;
