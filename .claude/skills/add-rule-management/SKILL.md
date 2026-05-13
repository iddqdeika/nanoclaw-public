---
name: add-rule-management
description: Add tier-scoped rule and skill management to NanoClaw. Enables adding/removing markdown rules and skills per tier (core/trusted/admin/untrusted) from chat or Claude Code CLI. Integrates with the trust-group model.
---

# Add Rule Management

Adds a 4-tier rule and skill management system to NanoClaw:

- **Rules** — markdown instruction files injected into agent prompts by the host
- **Skills** — Claude Code slash-command directories synced to agents at container launch

**Tiers (loaded by trust level):**

| Tier | Rules dir | Skills dir | Loaded for |
|------|-----------|-----------|------------|
| `core` | `rules/core/` | `skills/core/` | All trust levels |
| `trusted` | `rules/trusted/` | `skills/trusted/` | main + trusted |
| `admin` | `rules/admin/` | `skills/admin/` | main only |
| `untrusted` | `rules/untrusted/` | `skills/untrusted/` | untrusted only |

Only the main group can add or remove rules and skills (enforced at IPC level). Trusted groups can read them but not modify.

See `docs/trust-groups.md` for the full trust-group design.

---

## Phase 1: Pre-flight

Check if already applied:

```bash
test -f src/rules-loader.ts && echo "Already applied" || echo "Not applied"
```

If already applied, stop here.

---

## Phase 2: Create directory structure

```bash
mkdir -p rules/core rules/admin rules/untrusted
mkdir -p container/skills-admin container/skills-untrusted
touch rules/core/.gitkeep rules/admin/.gitkeep rules/untrusted/.gitkeep
touch container/skills-admin/.gitkeep container/skills-untrusted/.gitkeep
```

---

## Phase 3: Create src/rules-loader.ts

Create `src/rules-loader.ts`:

```typescript
import fs from 'fs';
import path from 'path';

const RULES_DIR = path.join(process.cwd(), 'rules');

function readScopeFiles(scope: 'core' | 'admin' | 'untrusted'): string[] {
  const dir = path.join(RULES_DIR, scope);
  if (!fs.existsSync(dir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }

  return files.flatMap((f) => {
    try {
      const content = fs.readFileSync(path.join(dir, f), 'utf-8').trim();
      return content ? [content] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Load rules for a container invocation.
 * Core rules apply to all groups; admin rules apply to main groups only;
 * untrusted rules apply to non-main groups only.
 */
export function loadRules(isMain: boolean): string {
  const parts = [
    ...readScopeFiles('core'),
    ...readScopeFiles(isMain ? 'admin' : 'untrusted'),
  ];
  return parts.join('\n\n---\n\n');
}
```

---

## Phase 4: Modify src/index.ts

### 4a. Add import

Find the import block near `group-folder.js` and add:

```typescript
import { loadRules } from './rules-loader.js';
```

### 4b. Inject rules into prompt

In `runAgent()`, find the `runContainerAgent` call inside the `try` block. Before it, add:

```typescript
    const rules = loadRules(isMain);
    const finalPrompt = rules
      ? `<system_rules>\n${rules}\n</system_rules>\n\n${prompt}`
      : prompt;
```

Then change `prompt` to `finalPrompt` in the `runContainerAgent` call:

```typescript
      {
        prompt: finalPrompt,   // was: prompt
        sessionId,
        ...
      },
```

---

## Phase 5: Modify src/container-runner.ts

Find the core skill sync block (search for `Sync skills from skills/`). Immediately after it, add the scoped skill sync:

```typescript
  // Sync scoped skills: admin for main groups, untrusted for non-main groups
  const scopedSkillsSrc = path.join(
    process.cwd(),
    'container',
    isMain ? 'skills-admin' : 'skills-untrusted',
  );
  if (fs.existsSync(scopedSkillsSrc)) {
    for (const skillDir of fs.readdirSync(scopedSkillsSrc)) {
      const srcDir = path.join(scopedSkillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
```

---

## Phase 6: Modify src/ipc.ts

### 6a. Add helpers and extend data type

Find `export async function processTaskIpc(` and insert before it:

```typescript
function isValidScope(scope: unknown): scope is 'core' | 'admin' | 'untrusted' {
  return scope === 'core' || scope === 'admin' || scope === 'untrusted';
}

function isValidName(name: unknown): name is string {
  if (typeof name !== 'string' || !name) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

function skillScopeDir(scope: 'core' | 'admin' | 'untrusted'): string {
  const base = path.join(process.cwd(), 'container');
  if (scope === 'core') return path.join(base, 'skills');
  return path.join(base, `skills-${scope}`);
}
```

In the `data` parameter type of `processTaskIpc`, add:

```typescript
    // For add_rule / remove_rule / add_skill / remove_skill
    scope?: string;
    content?: string;
    files?: Record<string, string>;
```

### 6b. Add four new cases

Find `default:` in the switch statement and insert before it:

```typescript
    case 'add_rule': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized add_rule attempt blocked');
        break;
      }
      const { scope, name, content } = data;
      if (!isValidScope(scope) || !isValidName(name) || typeof content !== 'string') {
        logger.warn({ data }, 'Invalid add_rule request');
        break;
      }
      const rulesDir = path.join(process.cwd(), 'rules', scope);
      fs.mkdirSync(rulesDir, { recursive: true });
      const fileName = name.endsWith('.md') ? name : `${name}.md`;
      fs.writeFileSync(path.join(rulesDir, fileName), content.slice(0, 65536), 'utf-8');
      logger.info({ scope, name, sourceGroup }, 'Rule added via IPC');
      break;
    }

    case 'remove_rule': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized remove_rule attempt blocked');
        break;
      }
      const { scope, name } = data;
      if (!isValidScope(scope) || !isValidName(name)) {
        logger.warn({ data }, 'Invalid remove_rule request');
        break;
      }
      const fileName = name.endsWith('.md') ? name : `${name}.md`;
      const filePath = path.join(process.cwd(), 'rules', scope, fileName);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info({ scope, name, sourceGroup }, 'Rule removed via IPC');
      } else {
        logger.warn({ scope, name }, 'Rule file not found for removal');
      }
      break;
    }

    case 'add_skill': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized add_skill attempt blocked');
        break;
      }
      const { scope, name, files } = data;
      if (!isValidScope(scope) || !isValidName(name) || typeof files !== 'object' || !files) {
        logger.warn({ data }, 'Invalid add_skill request');
        break;
      }
      const targetDir = path.join(skillScopeDir(scope), name);
      fs.mkdirSync(targetDir, { recursive: true });
      for (const [fileName, fileContent] of Object.entries(files)) {
        if (!isValidName(fileName.replace(/\.[^.]+$/, ''))) continue;
        fs.writeFileSync(path.join(targetDir, fileName), String(fileContent).slice(0, 65536), 'utf-8');
      }
      logger.info({ scope, name, sourceGroup }, 'Skill added via IPC');
      break;
    }

    case 'remove_skill': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized remove_skill attempt blocked');
        break;
      }
      const { scope, name } = data;
      if (!isValidScope(scope) || !isValidName(name)) {
        logger.warn({ data }, 'Invalid remove_skill request');
        break;
      }
      const targetDir = path.join(skillScopeDir(scope), name);
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        logger.info({ scope, name, sourceGroup }, 'Skill removed via IPC');
      } else {
        logger.warn({ scope, name }, 'Skill directory not found for removal');
      }
      break;
    }
```

---

## Phase 7: Modify container/agent-runner/src/ipc-mcp-stdio.ts

Find `// Start the stdio transport` and insert before it four new MCP tools. Note: this project uses **Zod v4** — `z.record()` requires two arguments.

```typescript
server.tool(
  'add_rule',
  `Add or update a rule injected into agent prompts. Main group only.
Scopes: "core" (all groups), "admin" (main only), "untrusted" (non-main only).
Rules take effect on the next message — no restart needed.`,
  {
    scope: z.enum(['core', 'admin', 'untrusted']).describe('Which groups this rule applies to'),
    name: z.string().describe('Rule name, e.g. "no-links"'),
    content: z.string().describe('Rule text in markdown.'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage rules.' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, { type: 'add_rule', scope: args.scope, name: args.name, content: args.content, timestamp: new Date().toISOString() });
    return { content: [{ type: 'text' as const, text: `Rule "${args.name}" added to scope "${args.scope}". Takes effect on next message.` }] };
  },
);

server.tool(
  'remove_rule',
  'Remove a rule by name and scope. Main group only.',
  {
    scope: z.enum(['core', 'admin', 'untrusted']).describe('Scope of the rule to remove'),
    name: z.string().describe('Name of the rule to remove'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage rules.' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, { type: 'remove_rule', scope: args.scope, name: args.name, timestamp: new Date().toISOString() });
    return { content: [{ type: 'text' as const, text: `Rule "${args.name}" removal requested from scope "${args.scope}".` }] };
  },
);

server.tool(
  'add_skill',
  `Add or update a skill (slash command) available to agents. Main group only.
Scopes: "core" (all groups), "admin" (main only), "untrusted" (non-main only).
Takes effect on next container start. files must include "SKILL.md".`,
  {
    scope: z.enum(['core', 'admin', 'untrusted']).describe('Which groups this skill is available to'),
    name: z.string().describe('Skill directory name, e.g. "my-skill"'),
    files: z.record(z.string(), z.string()).describe('Map of filename to content. Must include "SKILL.md".'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage skills.' }], isError: true };
    }
    if (!args.files['SKILL.md']) {
      return { content: [{ type: 'text' as const, text: 'files must include "SKILL.md".' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, { type: 'add_skill', scope: args.scope, name: args.name, files: args.files, timestamp: new Date().toISOString() });
    return { content: [{ type: 'text' as const, text: `Skill "${args.name}" added to scope "${args.scope}". Takes effect on next container start.` }] };
  },
);

server.tool(
  'remove_skill',
  'Remove a skill by name and scope. Main group only. Takes effect on next container start.',
  {
    scope: z.enum(['core', 'admin', 'untrusted']).describe('Scope of the skill to remove'),
    name: z.string().describe('Skill directory name to remove'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only the main group can manage skills.' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, { type: 'remove_skill', scope: args.scope, name: args.name, timestamp: new Date().toISOString() });
    return { content: [{ type: 'text' as const, text: `Skill "${args.name}" removal requested from scope "${args.scope}".` }] };
  },
);
```

---

## Phase 8: Create admin container skill

Create `container/skills-admin/manage-rules/SKILL.md`:

```markdown
---
name: manage-rules
description: Add, update, or remove scoped rules and skills via IPC. Main group only.
---

# /manage-rules — Manage Rules and Skills

Add, update, or remove rules (prompt instructions) and skills (slash commands) across three scopes.

## Scopes

| Scope | Applies to |
|-------|------------|
| `core` | All groups |
| `admin` | Main group only |
| `untrusted` | Non-main groups only |

## Rules

Rules are injected into every agent prompt for groups in that scope. Takes effect on next message.

\`\`\`
mcp__nanoclaw__add_rule(scope, name, content)
mcp__nanoclaw__remove_rule(scope, name)
\`\`\`

## Skills

Skills are slash commands synced to \`.claude/skills/\`. Takes effect on next container start.

\`\`\`
mcp__nanoclaw__add_skill(scope, name, files)    # files = { "SKILL.md": "..." }
mcp__nanoclaw__remove_skill(scope, name)
\`\`\`

## Inspect current rules/skills

\`\`\`bash
ls /workspace/project/rules/core/ /workspace/project/rules/admin/ /workspace/project/rules/untrusted/ 2>/dev/null
ls /workspace/project/skills/ /workspace/project/container/skills-admin/ /workspace/project/container/skills-untrusted/ 2>/dev/null
\`\`\`

## Name rules

Names must match \`[a-zA-Z0-9][a-zA-Z0-9._-]*\` — no spaces, no slashes.
```

---

## Phase 9: Build and restart

```bash
npm run build
pm2 restart nanoclaw   # or: systemctl --user restart nanoclaw
./container/build.sh
```

Build must be clean before restarting.

---

## Verify

After restart, rules in `rules/core/` should be injected into the next agent prompt. To confirm:

1. Drop a test `.md` file in `rules/core/` with a recognizable phrase
2. Trigger the agent in any group
3. Check that the agent follows the rule

To verify skills: place a skill directory in `container/skills-admin/`, rebuild the container, then start the main group agent and run `/capabilities` — the skill should appear.
