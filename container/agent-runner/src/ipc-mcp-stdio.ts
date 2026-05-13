/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const trustLevel = process.env.NANOCLAW_TRUST_LEVEL || 'untrusted';
const isMain = trustLevel === 'main';
const isTrusted = trustLevel === 'trusted' || isMain;
// Default thread context: the thread where the bot was addressed (if any).
const defaultThreadId = process.env.NANOCLAW_THREAD_ID || undefined;

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. On Slack: if thread_ts is provided (or a default thread context exists), the message is sent as a thread reply.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a per-role identity: in Telegram a renamed pool bot, in Slack a chat.postMessage with custom username + icon_emoji. See /workspace/global/memory/personas.md for the persona library.',
      ),
    icon_emoji: z
      .string()
      .optional()
      .describe(
        'Slack-only avatar — a Slack emoji shortcode like ":mag:" or ":keyboard:". Pass alongside `sender` when posting from a swarm persona. Standard Slack/Unicode emoji only; custom workspace emoji require admin upload. Ignored on Telegram.',
      ),
    thread_ts: z
      .string()
      .optional()
      .describe(
        'Slack thread timestamp to reply into. Omit to use the default thread context (the thread where you were addressed), or pass a specific thread_ts to reply to a different thread.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      icon_emoji: args.icon_emoji || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
      threadTs: args.thread_ts || defaultThreadId,
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.

THREAD INHERITANCE - The task inherits your current thread by default. Reply goes back into the thread it was scheduled from. Pass thread_ts=null to override:
\u2022 RECURRING tasks (cron / interval): set thread_ts=null. They run for days or months; the original thread becomes stale or archived. Channel root keeps results visible.
\u2022 OPEN-ENDED ONCE tasks (\"check when the PR lands\", \"notify if X happens\" without a known ETA): set thread_ts=null. By the time they fire the thread may be dead.
\u2022 SHORT ONCE check-backs (\"check in 5 min\", \"recheck the build\"): omit thread_ts. The thread is alive and inheritance is what you want.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group. If set to a different group, thread_ts is ignored (the source thread is meaningless in the target group).',
      ),
    thread_ts: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Thread to reply into when the task fires. Omit to inherit your current thread (default). Pass null to post at channel root \u2014 use this for recurring tasks and any once-task whose completion time isn\'t certain (the source thread may be stale by the time it fires).',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    // Thread inheritance: by default capture the agent's current thread
    // context. Cross-group target → always drop (source thread doesn't
    // apply in the target group). Explicit `null` from the caller → root.
    // Explicit string → use that exact thread_ts.
    const crossGroup = targetJid !== chatJid;
    let resolvedThreadId: string | undefined;
    if (crossGroup) {
      resolvedThreadId = undefined;
    } else if (args.thread_ts === null) {
      resolvedThreadId = undefined;
    } else if (typeof args.thread_ts === 'string' && args.thread_ts.length > 0) {
      resolvedThreadId = args.thread_ts;
    } else {
      // omitted — inherit from agent's current context
      resolvedThreadId = defaultThreadId;
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      thread_id: resolvedThreadId,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
    trusted: z
      .boolean()
      .optional()
      .describe(
        'Trust level for the group. Default: false (untrusted — restricted rules, tools, and skills). Set to true only for groups you fully control and whose members should have elevated access (trusted rules + skills, task scheduling, subagents).',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      trusted: args.trusted ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

server.tool(
  'add_rule',
  `Add or update a rule that is injected into agent prompts. Main group only.

Scopes:
- "core"      — applies to ALL groups
- "admin"     — applies to main group only
- "untrusted" — applies to non-main groups only

Rules take effect on the next message (no restart needed). Name must be alphanumeric with hyphens/underscores. Use a descriptive name so rules are easy to identify and remove later.`,
  {
    scope: z
      .enum(['core', 'trusted', 'admin', 'untrusted'])
      .describe('Which groups this rule applies to'),
    name: z
      .string()
      .describe('Rule name, e.g. "no-profanity" or "response-format"'),
    content: z
      .string()
      .describe('The rule text in markdown. Keep concise and actionable.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can manage rules.',
          },
        ],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'add_rule',
      scope: args.scope,
      name: args.name,
      content: args.content,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Rule "${args.name}" added to scope "${args.scope}". Takes effect on next message.`,
        },
      ],
    };
  },
);

server.tool(
  'remove_rule',
  'Remove a rule by name and scope. Main group only.',
  {
    scope: z
      .enum(['core', 'trusted', 'admin', 'untrusted'])
      .describe('Scope of the rule to remove'),
    name: z.string().describe('Name of the rule to remove'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can manage rules.',
          },
        ],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'remove_rule',
      scope: args.scope,
      name: args.name,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Rule "${args.name}" removal requested from scope "${args.scope}".`,
        },
      ],
    };
  },
);

server.tool(
  'add_skill',
  `Add or update a skill (slash command) available to agents. Main group only.

Scopes:
- "core"      — available to ALL groups
- "admin"     — available to main group only
- "untrusted" — available to non-main groups only

A skill is a directory containing at minimum a SKILL.md file. The skill becomes available on the next container start. Name must be alphanumeric with hyphens/underscores.

SKILL.md frontmatter format:
\`\`\`
---
name: skill-name
description: One-line description shown in /capabilities
---
\`\`\``,
  {
    scope: z
      .enum(['core', 'trusted', 'admin', 'untrusted'])
      .describe('Which groups this skill is available to'),
    name: z
      .string()
      .describe('Skill directory name, e.g. "my-skill"'),
    files: z
      .record(z.string(), z.string())
      .describe(
        'Map of filename to content. Must include "SKILL.md". Example: { "SKILL.md": "---\\nname: my-skill\\n---\\n# /my-skill\\n..." }',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can manage skills.',
          },
        ],
        isError: true,
      };
    }

    if (!args.files['SKILL.md']) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'files must include "SKILL.md".',
          },
        ],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'add_skill',
      scope: args.scope,
      name: args.name,
      files: args.files,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Skill "${args.name}" added to scope "${args.scope}". Takes effect on next container start.`,
        },
      ],
    };
  },
);

server.tool(
  'remove_skill',
  'Remove a skill by name and scope. Main group only. Takes effect on next container start.',
  {
    scope: z
      .enum(['core', 'trusted', 'admin', 'untrusted'])
      .describe('Scope of the skill to remove'),
    name: z.string().describe('Name of the skill directory to remove'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can manage skills.',
          },
        ],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'remove_skill',
      scope: args.scope,
      name: args.name,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Skill "${args.name}" removal requested from scope "${args.scope}".`,
        },
      ],
    };
  },
);

// spawn_agent (oneshot) MCP tool removed. Use Task tool with subagent_type
// for delegation, or schedule_task for cross-group / async work. See
// rules/admin/oneshot-agents.md for the deprecation note.

// --- Persona management tools ---
//
// `add_persona` / `update_persona` / `delete_persona` let agents create,
// tune, and remove typed sub-agent definitions (Researcher, Coder, etc.).
//
// scope='group' writes directly to /home/node/.claude/agents/<name>.md —
// available immediately on the next Task spawn IN THIS GROUP only.
//
// scope='global' emits an IPC task to the host. The host writes the file
// to <project>/personas/<name>.md with `status: unconfirmed` frontmatter.
// Pendings are not synced into containers (so they can't be spawned)
// until an admin/is_main agent confirms via the pending-confirmations
// procedure (see rules/admin/pending-confirmations.md).

const PERSONA_NAME_RE = /^[a-z][a-z0-9-]*$/;
const HOME_AGENTS_DIR = '/home/node/.claude/agents';

const personaFrontmatterFields = {
  description: z
    .string()
    .min(20)
    .describe(
      'When the lead should pick this persona vs others. "Use for X. Don\'t use for Y." Read by lead at Task-spawn time.',
    ),
  tools: z
    .array(z.string())
    .min(1)
    .describe(
      'Allowlist of tool names. Wildcards like "mcp__gateway__*" allowed. SDK enforces — tools not in this list are unavailable to the persona.',
    ),
  model: z
    .enum(['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'])
    .describe(
      'Model to run this persona on. Pick by reasoning load: Haiku for text manipulation/coordination, Sonnet for working personas, Opus for hard reasoning.',
    ),
  system_prompt: z
    .string()
    .min(50)
    .describe(
      'The persona body — tone, discipline, format rules, output expectations. Becomes the SDK system prompt for this sub-agent type.',
    ),
};

function buildPersonaFile(args: {
  name: string;
  description: string;
  tools: string[];
  model: string;
  system_prompt: string;
  status?: string;
}): string {
  const fm: string[] = [
    '---',
    `name: ${args.name}`,
    `description: ${JSON.stringify(args.description)}`,
    `tools: ${args.tools.join(', ')}`,
    `model: ${args.model}`,
  ];
  if (args.status) fm.push(`status: ${args.status}`);
  fm.push('---', '');
  return fm.join('\n') + args.system_prompt.trim() + '\n';
}

server.tool(
  'add_persona',
  `Create a new typed sub-agent persona. The persona becomes spawnable as
\`Task(subagent_type: "<name>")\` once available.

scope='group' (no admin needed): writes to this group's local agents dir.
Available on the next Task spawn IN THIS GROUP only. Cheap, no review.

scope='global' (any tier may request): emits to the host, which writes
the file with \`status: unconfirmed\`. NOT spawnable until an admin
confirms via the pending-confirmations procedure. Use for personas you
want shared across all groups.

The full persona library lives at /workspace/global/memory/personas.md —
check it first to avoid duplicating an existing role.`,
  {
    name: z
      .string()
      .regex(PERSONA_NAME_RE, 'lowercase alphanumeric with hyphens, must start with a letter')
      .describe(
        'Slug — used as `subagent_type` value. Lowercase, hyphen-separated, no spaces. Must be unique across the persona library.',
      ),
    scope: z
      .enum(['group', 'global'])
      .describe(
        'group=writable here, available only in this group. global=host-side, requires admin confirmation, available everywhere once confirmed.',
      ),
    ...personaFrontmatterFields,
  },
  async (args) => {
    if (!isTrusted) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Persona management is restricted to trusted/main tiers. Your tier (untrusted) cannot create personas — propose the persona to an admin via your group conversation if it would be useful.',
          },
        ],
        isError: true,
      };
    }
    if (args.scope === 'group') {
      try {
        fs.mkdirSync(HOME_AGENTS_DIR, { recursive: true });
        const file = path.join(HOME_AGENTS_DIR, `${args.name}.md`);
        if (fs.existsSync(file)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Persona "${args.name}" already exists in this group. Use update_persona to modify it.`,
              },
            ],
            isError: true,
          };
        }
        fs.writeFileSync(file, buildPersonaFile(args));
        return {
          content: [
            {
              type: 'text' as const,
              text: `Created group-local persona "${args.name}". Spawn via Task(subagent_type: "${args.name}", prompt: "...") on your next turn (current SDK session won't pick it up — must be a fresh spawn).`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to write group-local persona: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    // scope === 'global' — emit IPC for host to handle
    writeIpcFile(TASKS_DIR, {
      type: 'add_persona',
      name: args.name,
      description: args.description,
      tools: args.tools,
      model: args.model,
      system_prompt: args.system_prompt,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Queued global persona "${args.name}" as unconfirmed. Admin/is_main will see it in pending-confirmations and either approve (it becomes spawnable) or reject. Until then, do not try to spawn it via Task.`,
        },
      ],
    };
  },
);

server.tool(
  'update_persona',
  `Modify an existing persona. Same scope semantics as add_persona.

scope='group' overwrites the local copy directly.

scope='global' writes the modified version with status: unconfirmed
alongside the existing confirmed file (named <name>.pending.md). Admin
confirms → replaces the original; rejects → pending file deleted.

Pass only the fields you want to change. Unspecified fields are kept
from the existing version (group scope) or filled in by the agent
when re-emitting (global scope, since IPC payload is self-contained).`,
  {
    name: z
      .string()
      .regex(PERSONA_NAME_RE)
      .describe('Name of the existing persona to modify.'),
    scope: z.enum(['group', 'global']),
    description: personaFrontmatterFields.description.optional(),
    tools: personaFrontmatterFields.tools.optional(),
    model: personaFrontmatterFields.model.optional(),
    system_prompt: personaFrontmatterFields.system_prompt.optional(),
  },
  async (args) => {
    if (!isTrusted) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Persona management is restricted to trusted/main tiers. Your tier (untrusted) cannot modify personas.',
          },
        ],
        isError: true,
      };
    }
    if (args.scope === 'group') {
      const file = path.join(HOME_AGENTS_DIR, `${args.name}.md`);
      if (!fs.existsSync(file)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No group-local persona "${args.name}" found. Use add_persona to create it.`,
            },
          ],
          isError: true,
        };
      }
      try {
        const existing = fs.readFileSync(file, 'utf-8');
        // Naive frontmatter parse — keeps whatever the caller didn't override
        const fmMatch = existing.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!fmMatch) throw new Error('existing file has no frontmatter');
        const fmRaw = fmMatch[1];
        const body = fmMatch[2];
        const get = (key: string) =>
          fmRaw.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1];
        const description = args.description ?? (() => {
          const raw = get('description') || '';
          return raw.startsWith('"') ? JSON.parse(raw) : raw;
        })();
        const toolsRaw = get('tools') || '';
        const tools = args.tools ?? toolsRaw.split(',').map((s) => s.trim()).filter(Boolean);
        const model = args.model ?? (get('model') || 'claude-sonnet-4-6');
        const system_prompt = args.system_prompt ?? body.trim();
        fs.writeFileSync(
          file,
          buildPersonaFile({
            name: args.name,
            description,
            tools,
            model,
            system_prompt,
          }),
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `Updated group-local persona "${args.name}". Effective on next Task spawn.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to update group-local persona: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    writeIpcFile(TASKS_DIR, {
      type: 'update_persona',
      name: args.name,
      description: args.description,
      tools: args.tools,
      model: args.model,
      system_prompt: args.system_prompt,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Queued update for global persona "${args.name}" as pending. Admin will see it in pending-confirmations.`,
        },
      ],
    };
  },
);

server.tool(
  'delete_persona',
  `Remove a persona.

scope='group' deletes the file from this group's local agents dir.

scope='global' emits an IPC mark-for-deletion. The persona file gets
\`status: pending_delete\` frontmatter (admin sees it in pending-
confirmations); on confirm the file is removed. The persona stays
spawnable until confirmed (so live conversations don't suddenly break).`,
  {
    name: z.string().regex(PERSONA_NAME_RE),
    scope: z.enum(['group', 'global']),
  },
  async (args) => {
    if (!isTrusted) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Persona management is restricted to trusted/main tiers. Your tier (untrusted) cannot delete personas.',
          },
        ],
        isError: true,
      };
    }
    if (args.scope === 'group') {
      const file = path.join(HOME_AGENTS_DIR, `${args.name}.md`);
      if (!fs.existsSync(file)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No group-local persona "${args.name}" to delete.`,
            },
          ],
          isError: true,
        };
      }
      try {
        fs.unlinkSync(file);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Deleted group-local persona "${args.name}".`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to delete: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    writeIpcFile(TASKS_DIR, {
      type: 'delete_persona',
      name: args.name,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Queued global persona "${args.name}" for deletion (pending admin confirmation).`,
        },
      ],
    };
  },
);

server.tool(
  'resolve_persona',
  `Confirm or reject a pending global persona action. Main/is_main groups
only — admin role for the pending-confirmations procedure.

The host inspects the file state and applies the right action:
- Pending NEW persona (status: unconfirmed) → confirm flips to confirmed,
  reject removes the file.
- Pending UPDATE proposal (<name>.pending.md exists) → confirm overwrites
  <name>.md and flips status, reject removes the .pending.md.
- Pending DELETE (status: pending_delete) → confirm removes the file,
  reject restores status to confirmed.

Use this in the pending-confirmations procedure. The file mounts are
read-only from the container, so direct Edit/Write to personas/<name>.md
won't work — this tool routes the action through the host.`,
  {
    name: z
      .string()
      .regex(PERSONA_NAME_RE)
      .describe('Persona name to resolve.'),
    decision: z
      .enum(['confirm', 'reject'])
      .describe(
        'confirm = approve the pending change. reject = discard / restore previous state.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'resolve_persona is admin-only — only main/is_main groups can confirm or reject pending personas.',
          },
        ],
        isError: true,
      };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'resolve_persona',
      name: args.name,
      decision: args.decision,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Queued ${args.decision} for persona "${args.name}". Host will apply on next IPC poll. Tell the user the result by checking your work — re-read personas/ if you want to verify the file state.`,
        },
      ],
    };
  },
);

server.tool(
  'simulate_failure',
  `[Admin only] Arm a synthetic failure for the NEXT turn of a group.
Used to test the recovery system without causing real outages.

When armed, the orchestrator's next runAgent attempt for the target group
short-circuits — instead of spawning a container, returns a fake error of
the requested type. The classifier + retry policy + sweep see realistic
failure shapes (network, rate_limit, auth_401, crash, idle_timeout, ...).

Single-use — consumed on first attempt, cleared automatically. For multi-
retry test scenarios, arm again after each consumption.

Survives orchestrator restart (file-backed at store/failure-simulations.json),
so you can arm + restart + observe boot hook behaviour.`,
  {
    error_type: z
      .enum([
        'network',
        'rate_limit',
        'upstream_5xx',
        'auth_401',
        'auth_403',
        'validation_400',
        'validation_404',
        'crash',
        'idle_timeout',
        'unknown',
      ])
      .describe('Error type the synthetic failure should classify as.'),
    target_group_folder: z
      .string()
      .optional()
      .describe(
        '(Main only) Group folder to arm. Defaults to caller\'s own group.',
      ),
    resets_at: z
      .string()
      .optional()
      .describe('For rate_limit only — ISO timestamp of when limit resets.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'simulate_failure is admin/main only.',
          },
        ],
        isError: true,
      };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'simulate_failure',
      error_type: args.error_type,
      target_group_folder: args.target_group_folder || groupFolder,
      resets_at: args.resets_at,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Armed failure simulation: ${args.error_type} for group "${args.target_group_folder || groupFolder}". Next turn for that group will short-circuit with this error.`,
        },
      ],
    };
  },
);

// Keep in sync with AGENT_CALLABLE_REACTIONS in src/reactions/vocabulary.ts.
// The orchestrator revalidates this on receipt, so drift is caught — but
// a mismatch just means the tool call fails. Better to keep them equal.
const AGENT_REACTIONS = [
  'working',
  'searching',
  'writing',
  'building',
  'thinking',
  'reading',
  'retrying',
] as const;

server.tool(
  'set_progress_reaction',
  `Add a progress reaction to the message that triggered the current turn.
This is the USER'S PROOF-OF-LIFE SIGNAL — the orchestrator only fires the
"saw" (message received) and "done"/"cancel" (turn end) reactions; the
middle signal is yours to send.

Call it ONCE, as early in the turn as possible, when the turn will take more
than a few seconds (multiple tool calls, research, long reasoning). Skip on
short instant-reply turns. Never call more than once per turn.

Pick the canonical name that best matches what you're doing:
  • working   — default "on it, actively engaged"
  • searching — researching or looking up information
  • writing   — composing output
  • building  — compiling or constructing
  • thinking  — deep reasoning
  • reading   — reading and absorbing content
  • retrying  — trying again after a failure

Each channel maps the name to an appropriate emoji. No platform specifics
to worry about. No-ops on WhatsApp and Telegram 1:1 DMs.`,
  {
    // Accept both the canonical field name and a legacy alias. Resumed
    // Claude sessions cache the old tool schema and may still send `emoji`
    // even after a container rebuild — tolerate it instead of silently
    // dropping the call.
    reaction: z.enum(AGENT_REACTIONS).optional(),
    emoji: z.string().optional(),
  },
  async (args) => {
    const raw = args.reaction ?? args.emoji ?? '';
    const reaction = String(raw).trim();
    if (!(AGENT_REACTIONS as readonly string[]).includes(reaction)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `reaction must be one of: ${AGENT_REACTIONS.join(', ')}`,
          },
        ],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'set_progress_reaction',
      reaction,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `Reaction "${reaction}" requested on current-turn trigger message.`,
        },
      ],
    };
  },
);

server.tool(
  'send_file',
  `Upload a file from the group folder to the current chat.

Write the file to disk first using your Write/Bash tools, then call this with
the container path (e.g. /workspace/group/report.pdf). The file must be under
/workspace/group/ — paths outside that root or containing '..' are rejected.

Slack: uploaded via files.uploadV2, posted as an attachment in the current
thread (or the thread specified via thread_ts). Telegram: sent as a photo for
jpg/png/webp, document for everything else. Images ≤ 25 MB default; tune
via SEND_FILE_SIZE_LIMIT env on the host.

Size limit: 25 MB. Oversized files are dropped with a warn log.
Available to main and trusted groups only.`,
  {
    file_path: z
      .string()
      .describe(
        'Container path to the file under /workspace/group/, e.g. /workspace/group/report.pdf',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional caption/comment posted alongside the file'),
    thread_ts: z
      .string()
      .optional()
      .describe(
        'Slack thread_ts to reply into. Defaults to the thread where you were addressed.',
      ),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'send_file',
      filePath: args.file_path,
      caption: args.caption,
      threadTs: args.thread_ts || defaultThreadId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: `File queued for upload: ${args.file_path}`,
        },
      ],
    };
  },
);

server.tool(
  'get_usage_metrics',
  `Query per-turn token usage and tool-call statistics.

Available only in the main group (the metrics DB lives on the host).
Returns either aggregated rows (default: daily buckets for the current
group) or raw per-turn rows if aggregate_by="none".

Each turn row/bucket includes total_input_tokens = input_tokens +
cache_creation_tokens + cache_read_tokens — that's the actual context
size sent to the model for that turn. Compare this across time to see
how context grows or shrinks.`,
  {
    since: z
      .string()
      .optional()
      .describe('ISO datetime lower bound (inclusive), e.g. "2026-04-01T00:00:00Z"'),
    until: z
      .string()
      .optional()
      .describe('ISO datetime upper bound (inclusive)'),
    aggregate_by: z
      .enum(['day', 'session', 'group', 'none'])
      .default('day')
      .describe(
        'Bucket size. "day" = one row per group per day; "session" = per session; "group" = one row per group; "none" = raw per-turn rows.',
      ),
    group_folder: z
      .string()
      .optional()
      .describe(
        'Target group folder (e.g. "slack_main"). Defaults to the querying group.',
      ),
    limit: z
      .number()
      .optional()
      .describe('Max rows returned. Default 500; upper bound 5000.'),
  },
  async (args) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeIpcFile(TASKS_DIR, {
      type: 'get_usage_metrics',
      requestId,
      since: args.since,
      until: args.until,
      aggregate_by: args.aggregate_by,
      target_group_folder: args.group_folder,
      limit: args.limit,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    // Poll for the response file the host will write.
    const responsePath = path.join(
      IPC_DIR,
      'responses',
      `${requestId}.json`,
    );
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(responsePath)) {
        try {
          const text = fs.readFileSync(responsePath, 'utf-8');
          try {
            fs.unlinkSync(responsePath);
          } catch {
            /* best-effort */
          }
          return {
            content: [{ type: 'text' as const, text }],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to read metrics response: ${(err as Error).message}`,
              },
            ],
            isError: true,
          };
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return {
      content: [
        {
          type: 'text' as const,
          text:
            'Timed out waiting for metrics response. Main group only — if you are not the main group the host rejects this call.',
        },
      ],
      isError: true,
    };
  },
);

// Memory tools — filesystem-derived semantic index. Per-tier ACL host-side.
// See docs/MEMORY-V2-PLAN.md for architecture.

async function callIpcRpc(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeIpcFile(TASKS_DIR, {
    type,
    requestId,
    groupFolder,
    timestamp: new Date().toISOString(),
    ...payload,
  });
  const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const text = fs.readFileSync(responsePath, 'utf-8');
        try {
          fs.unlinkSync(responsePath);
        } catch {
          /* best-effort */
        }
        const parsed = JSON.parse(text) as {
          ok: boolean;
          data?: unknown;
          error?: string;
        };
        return parsed;
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { ok: false, error: `${type} timed out after ${timeoutMs}ms` };
}

// Backwards-compat alias for memory tools.
const callMemoryRpc = callIpcRpc as (
  type: 'memory_search' | 'memory_reindex',
  payload: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<{ ok: boolean; data?: unknown; error?: string }>;

server.tool(
  'memory_search',
  `Search this group's memory index by semantic similarity to your query.

Returns top-k chunks, each with: file_path, line_start, line_end, content snippet, scope, score (cosine 0..1, higher = better). Every hit maps to a real markdown file you can Read with native tools.

Tier ACL: untrusted reads own group only; trusted/main also read global memory.

Use this when you need to recall facts that aren't in your <recall> prefill — e.g. follow-up questions on a topic from earlier in the session.`,
  {
    query: z.string().describe('Free-text search query.'),
    k: z.number().int().optional().describe('Top-k results. Default 10, max 50.'),
  },
  async (args) => {
    const resp = await callMemoryRpc('memory_search', {
      query: args.query,
      k: args.k,
    });
    if (!resp.ok) {
      return {
        content: [{ type: 'text' as const, text: `Search failed: ${resp.error}` }],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(resp.data, null, 2) },
      ],
    };
  },
);

server.tool(
  'memory_reindex',
  `Rebuild the memory index for this group from source markdown files.

Run after writing or editing CLAUDE.md, wiki pages, or global memory files — the index won't see those changes until reindexed. The default behavior (no args) is what you want most of the time: partial reindex of all three sources for your group, fast because unchanged files are skipped via SHA-256.

Common usages:

  memory_reindex()
    → partial reindex of group CLAUDE.md + wiki + global/memory for this group.

  memory_reindex({ filePath: "/workspace/group/wiki/customers.md" })
    → reindex one specific file you just edited. Container paths
      (/workspace/group/..., /workspace/global/...) are accepted.

  memory_reindex({ partial: false })
    → force full re-embed of every file. Rarely needed; use after a
      semantic-model change or a corrupt index.

If you call with a filePath and get back \`{ filesIndexed: 0, filesSkipped: 0 }\`, the path didn't match any source root. Check that it's under /workspace/group/, /workspace/group/wiki/, or /workspace/global/memory/.`,
  {
    partial: z
      .boolean()
      .optional()
      .describe('Skip unchanged files (SHA-256 check). Default true.'),
    filePath: z
      .string()
      .optional()
      .describe(
        'One file to reindex. Accepts container paths (/workspace/group/..., /workspace/global/...) or absolute host paths. Omit for a partial reindex of all sources.',
      ),
  },
  async (args) => {
    const resp = await callMemoryRpc('memory_reindex', {
      partial: args.partial,
      filePath: args.filePath,
    });
    if (!resp.ok) {
      return {
        content: [{ type: 'text' as const, text: `Reindex failed: ${resp.error}` }],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(resp.data, null, 2) },
      ],
    };
  },
);

// --- Conversation-history tools ---
//
// All four are scoped to the current channel only — no chat_jid argument.
// On non-threading channels (WhatsApp, basic Telegram), `list_threads`
// returns an empty array; the others work identically (thread_id is null
// or equal to the message id, so messages collapse into a flat history).

server.tool(
  'list_recent_messages',
  `List recent messages from THIS channel.

Use when the visible \`<messages>\` block is too narrow and you need to see what was happening recently in the channel. Defaults to top-level messages only (\`scope: 'root'\`) so unrelated thread chatter doesn't drown the list.

Returns an array of messages with id, sender, sender_name, content, timestamp, thread_id, and reply context. Order: chronological (oldest first).`,
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Max messages returned. Default 50; upper bound 500.'),
    scope: z
      .enum(['root', 'all'])
      .optional()
      .describe(
        "'root' (default) returns only top-level messages; 'all' includes thread replies in time order.",
      ),
    since: z
      .string()
      .optional()
      .describe(
        'ISO 8601 timestamp; only messages newer than this are returned. Optional.',
      ),
  },
  async (args) => {
    const resp = await callIpcRpc('list_recent_messages', {
      limit: args.limit,
      message_scope: args.scope,
      since: args.since,
    });
    if (!resp.ok) {
      return {
        content: [
          { type: 'text' as const, text: `list_recent_messages failed: ${resp.error}` },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(resp.data, null, 2) },
      ],
    };
  },
);

server.tool(
  'list_threads',
  `List recent threads in THIS channel — one entry per distinct thread, with the parent message snippet, reply count, and last activity.

Use to find a thread by its topic when you don't know the thread_id. On non-threading channels (WhatsApp, basic Telegram) this returns an empty array — use \`list_recent_messages\` or \`search_messages\` instead.

Returns: \`{ threads: [{ thread_id, parent_snippet, parent_sender, reply_count, last_activity, participant_count }] }\`. Order: most recently active first.`,
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Max threads returned. Default 20; upper bound 200.'),
    since: z
      .string()
      .optional()
      .describe(
        'ISO 8601 timestamp; only threads with activity after this are returned. Optional.',
      ),
  },
  async (args) => {
    const resp = await callIpcRpc('list_threads', {
      limit: args.limit,
      since: args.since,
    });
    if (!resp.ok) {
      return {
        content: [
          { type: 'text' as const, text: `list_threads failed: ${resp.error}` },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(resp.data, null, 2) },
      ],
    };
  },
);

server.tool(
  'get_thread',
  `Fetch every message of a specific thread in THIS channel — parent + all replies, chronological.

Use when you have a \`thread_id\` (from \`list_threads\`, from a search result, or from the \`thread_ts\` attribute on a visible message) and need the full thread context. Bypasses the prompt's per-turn message window. Capped at 500 messages / 200 KB; if truncated, parent + most-recent replies are kept and \`truncated: true\` is set.

Returns: \`{ messages: [...], truncated: boolean, totalCount: number }\`.`,
  {
    thread_id: z
      .string()
      .min(1)
      .describe(
        "The thread identifier — the channel-native ts/id of the thread parent.",
      ),
  },
  async (args) => {
    const resp = await callIpcRpc('get_thread', {
      thread_id: args.thread_id,
    });
    if (!resp.ok) {
      return {
        content: [
          { type: 'text' as const, text: `get_thread failed: ${resp.error}` },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(resp.data, null, 2) },
      ],
    };
  },
);

server.tool(
  'search_messages',
  `Plain-text keyword search across THIS channel's history.

Use when you need to find a message by content — a project name, a quoted phrase, a URL fragment. Matches are ordered by recency and grouped by thread on threading channels (Slack, Telegram topics, Discord) so you can see each thread's hits in context.

Returns: \`{ threads: [{ thread_id, parent_snippet, hits: [...] }], root: [...], totalMatches: number }\` for threading channels, or \`{ flat: [...], totalMatches }\` when no threads exist. Hits include id, sender_name, timestamp, content, thread_id.

Limitations: substring match (LIKE), no ranking. Use specific keywords for best results. Future: FTS5 + vector search planned.`,
  {
    query: z
      .string()
      .min(1)
      .describe('Substring to search for in message content. Required.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Max matches returned. Default 20; upper bound 200.'),
    since: z
      .string()
      .optional()
      .describe(
        'ISO 8601 timestamp; only messages newer than this are searched.',
      ),
    sender: z
      .string()
      .optional()
      .describe(
        "Restrict to messages from a specific sender — matches sender_name OR sender id (substring).",
      ),
  },
  async (args) => {
    const resp = await callIpcRpc('search_messages', {
      query: args.query,
      limit: args.limit,
      since: args.since,
      sender: args.sender,
    });
    if (!resp.ok) {
      return {
        content: [
          { type: 'text' as const, text: `search_messages failed: ${resp.error}` },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(resp.data, null, 2) },
      ],
    };
  },
);

// --- Main-tier tools (self-improve + delete) ---
// Registered ONLY when trustLevel === 'main'. Host-side IPC handlers
// in src/ipc.ts do their own main-only ACL check as defense-in-depth.

if (isMain) {
  server.tool(
    'read_group_claude_md',
    `Read another group's CLAUDE.md.

Returns { content, exists }. content=null + exists=false means the group has no CLAUDE.md yet.

Main-tier only. \`folder\` is the registered group folder, e.g. "slack_p-resale-sales", "slack_main", "telegram_main". You can also read CLAUDE.md directly with the \`Read\` tool from /workspace/project/groups/<folder>/CLAUDE.md — this MCP tool is just a shortcut.`,
    {
      folder: z.string().min(1),
    },
    async (args) => {
      const resp = await callIpcRpc('read_group_claude_md', {
        target_folder: args.folder,
      });
      if (!resp.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `read_group_claude_md failed: ${resp.error}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(resp.data, null, 2) },
        ],
      };
    },
  );

  server.tool(
    'update_group_claude_md',
    `Write a new CLAUDE.md for a group. Use only after the user explicitly accepted a proposal.

Validations the host enforces (failure returns isError=true with a reason):
- folder must be a registered group folder
- content non-empty, ≤ 64 KB
- new content must differ from existing CLAUDE.md (no-op rejected)

Returns { applied_at, old_sha256, new_sha256 } on success.`,
    {
      folder: z.string().min(1),
      content: z
        .string()
        .min(1)
        .describe("Full new contents of the group's CLAUDE.md."),
      accepted_by: z
        .string()
        .optional()
        .describe('Who accepted (Slack display name). Optional.'),
    },
    async (args) => {
      const resp = await callIpcRpc('update_group_claude_md', {
        target_folder: args.folder,
        content: args.content,
        accepted_by: args.accepted_by,
      });
      if (!resp.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `update_group_claude_md failed: ${resp.error}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(resp.data, null, 2) },
        ],
      };
    },
  );

  server.tool(
    'delete_message',
    `Delete a message from the current chat. Removes it from the channel (Slack chat.delete) AND from messages.db so it doesn't show up in <messages> blocks anymore.

Slack: only works for messages this bot itself sent (no admin scope).
\`message_id\` is the message's ts (Slack) or message_id (Telegram).

Returns { slackDeleted, dbDeleted, message_id }. slackDeleted=false + dbDeleted=true means the channel API failed but the DB was cleaned (e.g. message already deleted in Slack but still in our DB).`,
    {
      message_id: z
        .string()
        .min(1)
        .describe('The message id to delete (Slack ts, Telegram message_id).'),
    },
    async (args) => {
      const resp = await callIpcRpc('delete_message', {
        target_message_id: args.message_id,
      });
      if (!resp.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `delete_message failed: ${resp.error}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(resp.data, null, 2) },
        ],
      };
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
