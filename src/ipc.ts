import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { AvailableGroup, bumpContainerActivity } from './container-runner.js';
import {
  ErrorType,
} from './error-classifier.js';
import { setFailureSimulation } from './failure-simulator.js';
import {
  createTask,
  deleteStoredMessage,
  deleteTask,
  getTaskById,
  getThreadMessages,
  listRecentMessages,
  listThreads,
  queryTurnMetrics,
  searchMessages,
  updateTask,
} from './db.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { markExhausted } from './model-exhaustion.js';
import {
  isCanonicalReaction,
  type AgentReaction,
} from './reactions/vocabulary.js';
import { RegisteredGroup } from './types.js';
import {
  searchChunks,
  type MemoryScope,
  type MemoryTier,
} from './memory/index-store.js';
import { reindexGroup } from './memory/indexer.js';
import crypto from 'crypto';

// Same cap as inbound. 25 MB default; tune via SEND_FILE_SIZE_LIMIT env.
const SEND_FILE_SIZE_LIMIT =
  parseInt(process.env.SEND_FILE_SIZE_LIMIT || '', 10) || 25 * 1024 * 1024;

/**
 * Translate an agent's container path to a host path under the group folder.
 * Returns null if the path escapes /workspace/group/ or contains unsafe segments.
 */
function containerPathToHost(
  containerPath: string,
  groupFolder: string,
): string | null {
  const prefix = '/workspace/group/';
  if (typeof containerPath !== 'string') return null;
  if (!containerPath.startsWith(prefix)) return null;
  const rel = containerPath.slice(prefix.length);
  // Reject path traversal.
  if (rel.split(/[/\\]/).some((seg) => seg === '..' || seg === '')) {
    return null;
  }
  return `${resolveGroupFolderPath(groupFolder)}/${rel}`;
}

/**
 * Translate a memory_reindex filePath argument (which may be a container path
 * the agent naturally constructs) into a host path the indexer can match
 * against MEMORY_SOURCES roots. Accepts:
 *
 *   /workspace/group/<rel>        → <repo>/groups/{sourceGroup}/<rel>
 *   /workspace/global/<rel>       → <repo>/groups/global/<rel>
 *   <already absolute host path>  → returned unchanged
 *
 * Returns null for shapes we don't recognise so the caller can surface a
 * clear error instead of silently feeding a non-matching path to the indexer
 * (which would return filesIndexed=0, filesSkipped=0 — the original bug).
 *
 * Path traversal is rejected for the /workspace/* mappings; absolute host
 * paths are trusted by virtue of the IPC source-group authentication
 * (the agent can only write IPC requests for its own group folder, and the
 * indexer's startsWith(root) check still bounds the result).
 */
function memoryFilePathToHost(
  filePath: string,
  sourceGroup: string,
): string | null {
  if (typeof filePath !== 'string' || !filePath) return null;

  // Already host-shaped: Windows drive letter (C:\...) or POSIX absolute that
  // doesn't start with /workspace/. Pass through.
  const isWindowsAbs = /^[a-zA-Z]:[\\/]/.test(filePath);
  const isPosixAbsNonContainer =
    filePath.startsWith('/') && !filePath.startsWith('/workspace/');
  if (isWindowsAbs || isPosixAbsNonContainer) return filePath;

  const tryMap = (prefix: string, rootRel: string[]): string | null => {
    if (!filePath.startsWith(prefix)) return null;
    const rel = filePath.slice(prefix.length);
    if (rel.split(/[/\\]/).some((seg) => seg === '..' || seg === '')) {
      return null;
    }
    return path.join(process.cwd(), ...rootRel, rel);
  };

  return (
    tryMap('/workspace/group/', ['groups', sourceGroup]) ??
    tryMap('/workspace/global/', ['groups', 'global'])
  );
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string, threadId?: string) => Promise<void>;
  /**
   * Send a swarm/agent-team message via the channel's pool of per-role
   * identities. When the channel for `jid` does not implement pool routing,
   * this should fall back to sendMessage with a "[Sender] " prefix.
   */
  sendPoolMessage?: (
    jid: string,
    text: string,
    sender: string,
    groupFolder: string,
    iconEmoji?: string,
    threadId?: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  /**
   * Set a custom progress reaction on the trigger message of the turn
   * currently running for the given group folder. No-op if no active turn.
   * The caller is responsible for passing a valid AgentReaction — the IPC
   * handler validates it before this is invoked.
   */
  reactToActiveTurn?: (
    sourceGroup: string,
    reaction: AgentReaction,
  ) => Promise<void>;
  /**
   * Upload a file to a chat. `filePath` is a host-side absolute path —
   * the IPC handler translates the agent's container path before calling.
   */
  sendFile?: (
    jid: string,
    filePath: string,
    opts?: { caption?: string; threadId?: string },
  ) => Promise<void>;
  /**
   * Delete a message from the chat. Routes to the channel that owns the jid.
   * Channels with no deletion support throw (caller catches and reports).
   */
  deleteMessage?: (jid: string, messageId: string) => Promise<void>;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // The agent in `sourceGroup` is doing real work — keep
                // its idle watchdog quiet even if its stdout stream is
                // currently silent (e.g. mid-tool-call).
                bumpContainerActivity(sourceGroup);
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (data.sender && deps.sendPoolMessage) {
                    // Swarm route: send_message was called with a sender
                    // (subagent role). Deliver via per-role identity.
                    await deps.sendPoolMessage(
                      data.chatJid,
                      data.text,
                      data.sender,
                      sourceGroup,
                      typeof data.icon_emoji === 'string'
                        ? data.icon_emoji
                        : undefined,
                      data.threadTs || undefined,
                    );
                  } else {
                    await deps.sendMessage(
                      data.chatJid,
                      data.text,
                      data.threadTs || undefined,
                    );
                  }
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      sender: data.sender,
                    },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Any IPC from this group (set_progress_reaction, memory_*,
              // schedule_task, send_file, etc.) means the agent is alive
              // and working — refresh its idle watchdog. Without this,
              // long tool calls that emit IPC but no stdout get reaped.
              bumpContainerActivity(sourceGroup);
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

type RuleTier = 'core' | 'trusted' | 'admin' | 'untrusted';

function isValidScope(scope: unknown): scope is RuleTier {
  return (
    scope === 'core' ||
    scope === 'trusted' ||
    scope === 'admin' ||
    scope === 'untrusted'
  );
}

function isValidName(name: unknown): name is string {
  if (typeof name !== 'string' || !name) return false;
  // No path traversal, no slashes, must start with alphanumeric
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

/** Path to the tier subdirectory inside skills/ (all tiers unified). */
function skillTierDir(tier: RuleTier): string {
  return path.join(process.cwd(), 'skills', tier);
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    trusted?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For add_rule / remove_rule / add_skill / remove_skill
    scope?: string;
    content?: string;
    files?: Record<string, string>;
    // For set_progress_reaction — canonical reaction name from the vocabulary
    reaction?: string;
    // For send_file
    filePath?: string;
    caption?: string;
    threadTs?: string;
    // For get_usage_metrics (agent writes a request file; host writes result
    // to a response file that the MCP tool reads back)
    requestId?: string;
    since?: string;
    until?: string;
    aggregate_by?: string;
    target_group_folder?: string;
    limit?: number;
    // For model_exhausted (agent-runner emits on rate-limit detection)
    model?: string;
    resets_at?: string;
    rate_limit_type?: string;
    // For memory_* tools
    query?: string;
    k?: number;
    partial?: boolean;
    // For history tools (list_recent_messages / list_threads / get_thread / search_messages).
    // Note: a separate `message_scope` field — `scope` is already taken by add_rule/skill.
    message_scope?: 'root' | 'all';
    sender?: string;
    thread_id?: string;
    // For self-improve IPC (read_group_claude_md / update_group_claude_md).
    // Main-only.
    target_folder?: string;
    accepted_by?: string;
    // For delete_message IPC. Main-only.
    target_message_id?: string;
    // For add_persona / update_persona / delete_persona / resolve_persona.
    tools?: unknown;
    description?: string;
    system_prompt?: string;
    decision?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        // Thread inheritance: agent-runner already resolved it (null/empty
        // for cross-group / opt-out, populated otherwise). Just persist.
        const threadId =
          typeof data.thread_id === 'string' && data.thread_id.length > 0
            ? data.thread_id
            : null;
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          thread_id: threadId,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        // Merge trusted flag into containerConfig. The top-level `trusted`
        // field is a convenience for the MCP tool; it gets stored inside
        // containerConfig.trusted (which is what getTrustLevel reads).
        const containerConfig: RegisteredGroup['containerConfig'] =
          data.containerConfig ?? existingGroup?.containerConfig ?? undefined;
        const withTrusted: RegisteredGroup['containerConfig'] =
          typeof data.trusted === 'boolean'
            ? { ...(containerConfig ?? {}), trusted: data.trusted }
            : containerConfig;
        // Default useMcpGateway to true for newly-registered groups so all
        // credentialed MCPs route through the host gateway (secrets stay on
        // the host, agent sees only the 4 meta-tools). Existing groups keep
        // whatever they had — never silently flip an explicit false to true.
        const finalContainerConfig: RegisteredGroup['containerConfig'] =
          withTrusted?.useMcpGateway === undefined && !existingGroup
            ? { ...(withTrusted ?? {}), useMcpGateway: true }
            : withTrusted;
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: finalContainerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'add_rule': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized add_rule attempt blocked');
        break;
      }
      const { scope, name, content } = data;
      if (
        !isValidScope(scope) ||
        !isValidName(name) ||
        typeof content !== 'string'
      ) {
        logger.warn({ data }, 'Invalid add_rule request');
        break;
      }
      const rulesDir = path.join(process.cwd(), 'rules', scope);
      fs.mkdirSync(rulesDir, { recursive: true });
      const fileName = name.endsWith('.md') ? name : `${name}.md`;
      fs.writeFileSync(
        path.join(rulesDir, fileName),
        content.slice(0, 65536),
        'utf-8',
      );
      logger.info({ scope, name, sourceGroup }, 'Rule added via IPC');
      break;
    }

    case 'remove_rule': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized remove_rule attempt blocked',
        );
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
      if (
        !isValidScope(scope) ||
        !isValidName(name) ||
        typeof files !== 'object' ||
        !files
      ) {
        logger.warn({ data }, 'Invalid add_skill request');
        break;
      }
      const targetDir = path.join(skillTierDir(scope), name);
      fs.mkdirSync(targetDir, { recursive: true });
      for (const [fileName, fileContent] of Object.entries(files)) {
        if (!isValidName(fileName.replace(/\.[^.]+$/, ''))) continue;
        fs.writeFileSync(
          path.join(targetDir, fileName),
          String(fileContent).slice(0, 65536),
          'utf-8',
        );
      }
      logger.info({ scope, name, sourceGroup }, 'Skill added via IPC');
      break;
    }

    case 'remove_skill': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized remove_skill attempt blocked',
        );
        break;
      }
      const { scope, name } = data;
      if (!isValidScope(scope) || !isValidName(name)) {
        logger.warn({ data }, 'Invalid remove_skill request');
        break;
      }
      const targetDir = path.join(skillTierDir(scope), name);
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        logger.info({ scope, name, sourceGroup }, 'Skill removed via IPC');
      } else {
        logger.warn({ scope, name }, 'Skill directory not found for removal');
      }
      break;
    }

    // ── Self-improve (PR 13) ─────────────────────────────────────────────
    // Three IPC handlers used by the nightly self-improvement proposer
    // running in the main group. All main-tier-only. Sister tools live in
    // container/agent-runner/src/ipc-mcp-stdio.ts and are gated by
    // trustLevel === 'main' so non-main containers can't even discover them.

    case 'read_group_claude_md': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized read_group_claude_md attempt blocked',
        );
        break;
      }
      const requestId = data.requestId;
      const folder = data.target_folder;
      const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
      fs.mkdirSync(responseDir, { recursive: true });
      const writeResp = (payload: object): void => {
        if (typeof requestId !== 'string' || !requestId) return;
        try {
          fs.writeFileSync(
            path.join(responseDir, `${requestId}.json`),
            JSON.stringify(payload),
          );
        } catch (err) {
          logger.warn(
            { sourceGroup, requestId, err: (err as Error).message },
            'read_group_claude_md: failed to write response',
          );
        }
      };
      if (typeof folder !== 'string' || !isValidGroupFolder(folder)) {
        writeResp({ ok: false, error: 'invalid folder' });
        break;
      }
      try {
        const filePath = path.join(resolveGroupFolderPath(folder), 'CLAUDE.md');
        if (!fs.existsSync(filePath)) {
          writeResp({
            ok: true,
            data: { folder, content: null, exists: false },
          });
          break;
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        writeResp({ ok: true, data: { folder, content, exists: true } });
      } catch (err) {
        logger.warn(
          { sourceGroup, folder, err: (err as Error).message },
          'read_group_claude_md failed',
        );
        writeResp({ ok: false, error: (err as Error).message });
      }
      break;
    }

    case 'update_group_claude_md': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized update_group_claude_md attempt blocked',
        );
        break;
      }
      const requestId = data.requestId;
      const folder = data.target_folder;
      const content = data.content;
      const acceptedBy = data.accepted_by;
      const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
      fs.mkdirSync(responseDir, { recursive: true });
      const writeResp = (payload: object): void => {
        if (typeof requestId !== 'string' || !requestId) return;
        try {
          fs.writeFileSync(
            path.join(responseDir, `${requestId}.json`),
            JSON.stringify(payload),
          );
        } catch (err) {
          logger.warn(
            { sourceGroup, requestId, err: (err as Error).message },
            'update_group_claude_md: failed to write response',
          );
        }
      };
      if (typeof folder !== 'string' || !isValidGroupFolder(folder)) {
        writeResp({ ok: false, error: 'invalid folder' });
        break;
      }
      if (typeof content !== 'string' || content.length === 0) {
        writeResp({ ok: false, error: 'content required (string)' });
        break;
      }
      if (content.length > 64 * 1024) {
        writeResp({ ok: false, error: 'content > 64 KB' });
        break;
      }
      try {
        const filePath = path.join(resolveGroupFolderPath(folder), 'CLAUDE.md');
        const oldContent = fs.existsSync(filePath)
          ? fs.readFileSync(filePath, 'utf-8')
          : '';
        const oldSha = crypto
          .createHash('sha256')
          .update(oldContent)
          .digest('hex');
        const newSha = crypto
          .createHash('sha256')
          .update(content)
          .digest('hex');
        if (oldSha === newSha) {
          writeResp({
            ok: false,
            error:
              'no-op: new content matches existing CLAUDE.md byte-for-byte',
          });
          break;
        }
        fs.writeFileSync(filePath, content, 'utf-8');
        logger.info(
          {
            folder,
            oldSha: oldSha.slice(0, 8),
            newSha: newSha.slice(0, 8),
            ...(typeof acceptedBy === 'string' ? { acceptedBy } : {}),
          },
          'CLAUDE.md updated via self-improve',
        );
        writeResp({
          ok: true,
          data: {
            folder,
            applied_at: new Date().toISOString(),
            old_sha256: oldSha,
            new_sha256: newSha,
          },
        });
      } catch (err) {
        logger.warn(
          { sourceGroup, folder, err: (err as Error).message },
          'update_group_claude_md failed',
        );
        writeResp({ ok: false, error: (err as Error).message });
      }
      break;
    }

    case 'delete_message': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized delete_message attempt blocked',
        );
        break;
      }
      const requestId = data.requestId;
      const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
      fs.mkdirSync(responseDir, { recursive: true });
      const writeResp = (payload: object): void => {
        if (typeof requestId !== 'string' || !requestId) return;
        try {
          fs.writeFileSync(
            path.join(responseDir, `${requestId}.json`),
            JSON.stringify(payload),
          );
        } catch {
          /* best-effort */
        }
      };
      // Find the source group's chat_jid — message id alone isn't unique
      // across channels, and we want to scope deletion to the calling
      // group's own chat (no cross-channel reach).
      const sourceJid = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === sourceGroup,
      )?.[0];
      const messageId = data.target_message_id;
      if (!sourceJid) {
        writeResp({ ok: false, error: 'source group not registered' });
        break;
      }
      if (typeof messageId !== 'string' || !messageId) {
        writeResp({ ok: false, error: 'message_id required' });
        break;
      }
      try {
        // Channel deletion (best-effort — Slack chat.delete only succeeds
        // for messages the bot itself sent).
        let slackDeleted = false;
        if (deps.deleteMessage) {
          try {
            await deps.deleteMessage(sourceJid, messageId);
            slackDeleted = true;
          } catch (err) {
            logger.warn(
              { sourceGroup, messageId, err: (err as Error).message },
              'delete_message: channel delete failed (continuing with DB)',
            );
          }
        }
        // DB cleanup — drop the row from messages.db so it doesn't show
        // up in <messages> blocks anymore.
        const dbDeleted = deleteStoredMessage(sourceJid, messageId);
        writeResp({
          ok: true,
          data: { slackDeleted, dbDeleted, message_id: messageId },
        });
      } catch (err) {
        writeResp({ ok: false, error: (err as Error).message });
      }
      break;
    }

    case 'spawn_agent': {
      // spawn_agent removed — oneshot agents replaced by Task subagents
      // and schedule_task. If an old container still has the spawn_agent
      // MCP tool registered, it might emit this; log and drop.
      logger.warn(
        { sourceGroup },
        'spawn_agent IPC received but oneshot infra has been removed; ignoring (use Task tool or schedule_task instead)',
      );
      break;
    }

    case 'simulate_failure': {
      // Admin-tier check. Source group must be is_main.
      const sourceGroupRecord = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      if (!sourceGroupRecord?.isMain) {
        logger.warn(
          { sourceGroup },
          'simulate_failure blocked: source group is not is_main',
        );
        break;
      }
      const target =
        typeof data.target_folder === 'string'
          ? data.target_folder
          : sourceGroup;
      const errorType =
        typeof data.scope === 'string' ? data.scope : undefined; // overload
      // We expect explicit fields error_type / resets_at on the payload.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any;
      const t = typeof d.error_type === 'string' ? d.error_type : errorType;
      const allowed = [
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
      ];
      if (!t || !allowed.includes(t)) {
        logger.warn(
          { sourceGroup, t },
          'simulate_failure: invalid error_type, dropping',
        );
        break;
      }
      setFailureSimulation(target, {
        errorType: t as ErrorType,
        resetsAt: typeof d.resets_at === 'string' ? d.resets_at : undefined,
      });
      logger.info(
        { sourceGroup, target, errorType: t },
        'simulate_failure armed via IPC',
      );
      break;
    }

    case 'resolve_persona': {
      // Admin/is_main resolves a pending persona. The host inspects the
      // current file state and applies the right action — admin doesn't
      // need to know whether it's a NEW pending, an UPDATE proposal, or
      // a pending DELETE; this handler figures it out.
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'resolve_persona blocked: source group is not is_main',
        );
        break;
      }
      const personasDir = path.join(process.cwd(), 'personas');
      const name = typeof data.name === 'string' ? data.name : '';
      const action: 'confirm' | 'reject' | undefined =
        data.decision === 'confirm' || data.decision === 'reject'
          ? data.decision
          : undefined;
      if (!/^[a-z][a-z0-9-]*$/.test(name) || !action) {
        logger.warn(
          { sourceGroup, name, decision: data.decision },
          'resolve_persona: invalid name or decision, dropping',
        );
        break;
      }
      const mainPath = path.join(personasDir, `${name}.md`);
      const pendingUpdatePath = path.join(personasDir, `${name}.pending.md`);
      try {
        const today = new Date().toISOString().slice(0, 10);

        // CASE 1: pending UPDATE (<name>.pending.md exists alongside <name>.md).
        if (fs.existsSync(pendingUpdatePath)) {
          if (action === 'confirm') {
            const proposal = fs.readFileSync(pendingUpdatePath, 'utf-8');
            const flipped = proposal
              .replace(/^status:\s*\S+/m, 'status: confirmed')
              .replace(/^pending_for:.*\n/m, '')
              .replace(/^created_by:.*\n/m, '')
              .replace(/^created_at:.*\n/m, '')
              .replace(/^---\n/m, `---\nconfirmed_at: ${today}\nconfirmed_by: user\n`);
            fs.writeFileSync(mainPath, flipped);
            fs.unlinkSync(pendingUpdatePath);
            logger.info({ sourceGroup, name }, 'persona update confirmed');
          } else {
            fs.unlinkSync(pendingUpdatePath);
            logger.info({ sourceGroup, name }, 'persona update rejected');
          }
          break;
        }

        // CASE 2: file with status: unconfirmed (NEW pending) or pending_delete.
        if (!fs.existsSync(mainPath)) {
          logger.warn(
            { sourceGroup, name },
            'resolve_persona: no such persona file',
          );
          break;
        }
        const existing = fs.readFileSync(mainPath, 'utf-8');
        const statusMatch = existing.match(/^status:\s*(\S+)/m);
        const status = statusMatch?.[1];

        if (status === 'unconfirmed') {
          if (action === 'confirm') {
            const flipped = existing
              .replace(/^status:\s*unconfirmed/m, 'status: confirmed')
              .replace(/^pending_for:.*\n/m, '')
              .replace(/^created_by:.*\n/m, '')
              .replace(
                /^---\n/m,
                `---\nconfirmed_at: ${today}\nconfirmed_by: user\n`,
              );
            fs.writeFileSync(mainPath, flipped);
            logger.info({ sourceGroup, name }, 'persona confirmed');
          } else {
            fs.unlinkSync(mainPath);
            logger.info({ sourceGroup, name }, 'persona rejected (deleted)');
          }
          break;
        }

        if (status === 'pending_delete') {
          if (action === 'confirm') {
            fs.unlinkSync(mainPath);
            logger.info(
              { sourceGroup, name },
              'persona deletion confirmed (file removed)',
            );
          } else {
            // Restore — strip pending_delete metadata, set status: confirmed.
            const restored = existing
              .replace(/^status:\s*pending_delete\n/m, 'status: confirmed\n')
              .replace(/^pending_delete_by:.*\n/m, '')
              .replace(/^pending_delete_at:.*\n/m, '');
            fs.writeFileSync(mainPath, restored);
            logger.info({ sourceGroup, name }, 'persona deletion rejected');
          }
          break;
        }

        logger.warn(
          { sourceGroup, name, status },
          'resolve_persona: file has no actionable pending status',
        );
      } catch (err) {
        logger.error(
          { sourceGroup, name, action, err },
          'resolve_persona handler failed',
        );
      }
      break;
    }

    case 'add_persona':
    case 'update_persona':
    case 'delete_persona': {
      // Global persona ops — file goes into <project>/personas/<name>.md
      // with status: unconfirmed (or pending_delete). Container-runner's
      // sync filter excludes non-confirmed entries from agents/, so the
      // persona is NOT spawnable until an admin/is_main agent flips
      // status: confirmed via the pending-confirmations procedure.
      //
      // Defense-in-depth tier check: even though the MCP tool blocks
      // untrusted-tier callers, a compromised container could write an
      // IPC file directly. Re-verify here. Trust = main OR trusted with
      // containerConfig.trusted === true.
      const sourceGroupRecord = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      const isTrusted =
        sourceGroupRecord?.isMain === true ||
        sourceGroupRecord?.containerConfig?.trusted === true;
      if (!isTrusted) {
        logger.warn(
          { sourceGroup, type: data.type },
          'persona IPC blocked: source group is untrusted tier',
        );
        break;
      }
      const personasDir = path.join(process.cwd(), 'personas');
      const name = typeof data.name === 'string' ? data.name : '';
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        logger.warn(
          { sourceGroup, name, type: data.type },
          'persona IPC: invalid name, dropping',
        );
        break;
      }
      try {
        fs.mkdirSync(personasDir, { recursive: true });
        const filePath = path.join(personasDir, `${name}.md`);

        if (data.type === 'delete_persona') {
          // Mark for deletion — flip frontmatter status to pending_delete.
          // The file stays spawnable (status was previously confirmed) until
          // admin confirms removal — keeps live conversations from breaking
          // mid-task.
          if (!fs.existsSync(filePath)) {
            logger.warn({ sourceGroup, name }, 'delete_persona: no such file');
            break;
          }
          const existing = fs.readFileSync(filePath, 'utf-8');
          const updated = existing.replace(
            /^---\n([\s\S]*?)\n---/,
            (_full, fm) => {
              const cleaned = fm.replace(/^status:.*$/m, '').replace(/\n\n+/g, '\n').trim();
              return `---\n${cleaned}\nstatus: pending_delete\npending_delete_by: ${sourceGroup}\npending_delete_at: ${new Date().toISOString()}\n---`;
            },
          );
          fs.writeFileSync(filePath, updated);
          logger.info(
            { sourceGroup, name },
            'persona marked for deletion (pending admin confirmation)',
          );
          break;
        }

        // add_persona / update_persona: write the proposed file with
        // status: unconfirmed. For update_persona on an existing
        // confirmed persona, write the proposal as <name>.pending.md
        // alongside the original so admin can diff before approving.
        const description = typeof data.description === 'string' ? data.description : '';
        const tools = Array.isArray(data.tools)
          ? (data.tools as unknown[]).filter((t): t is string => typeof t === 'string')
          : [];
        const model = typeof data.model === 'string' ? data.model : 'claude-sonnet-4-6';
        const systemPrompt = typeof data.system_prompt === 'string' ? data.system_prompt : '';
        if (!description || tools.length === 0 || !systemPrompt) {
          logger.warn(
            { sourceGroup, name, hasDesc: !!description, toolCount: tools.length, hasPrompt: !!systemPrompt },
            'persona IPC: missing required fields, dropping',
          );
          break;
        }

        const fmLines = [
          '---',
          `name: ${name}`,
          `description: ${JSON.stringify(description)}`,
          `tools: ${tools.join(', ')}`,
          `model: ${model}`,
          'status: unconfirmed',
          `pending_for: <messenger>_main`,
          `created_by: ${sourceGroup}`,
          `created_at: ${new Date().toISOString().slice(0, 10)}`,
          '---',
          '',
        ];
        const content = fmLines.join('\n') + systemPrompt.trim() + '\n';

        const isUpdate = data.type === 'update_persona';
        const existed = fs.existsSync(filePath);
        if (isUpdate && existed) {
          // Side-by-side proposal — admin diffs <name>.pending.md vs <name>.md.
          const pendingPath = path.join(personasDir, `${name}.pending.md`);
          fs.writeFileSync(pendingPath, content);
          logger.info(
            { sourceGroup, name },
            'persona update proposal queued (pending admin confirmation)',
          );
        } else if (!isUpdate && existed) {
          logger.warn(
            { sourceGroup, name },
            'add_persona for already-existing persona — ignored, use update_persona',
          );
        } else {
          // First-time add — write directly with unconfirmed status.
          fs.writeFileSync(filePath, content);
          logger.info(
            { sourceGroup, name, type: data.type },
            'persona created (pending admin confirmation)',
          );
        }
      } catch (err) {
        logger.error(
          { sourceGroup, name, type: data.type, err },
          'persona IPC handler failed',
        );
      }
      break;
    }

    case 'set_progress_reaction': {
      if (!deps.reactToActiveTurn) {
        logger.debug('set_progress_reaction received but dep not wired');
        break;
      }
      logger.info(
        { sourceGroup, raw: data },
        'set_progress_reaction: received IPC',
      );
      const { reaction } = data;
      if (!isCanonicalReaction(reaction)) {
        logger.warn(
          { sourceGroup, reaction, rawKeys: Object.keys(data) },
          'Invalid set_progress_reaction: not in canonical vocabulary',
        );
        break;
      }
      // Agent can only fire the progress-signal subset — saw/done/cancel are
      // reserved for the orchestrator.
      if (reaction === 'saw' || reaction === 'done' || reaction === 'cancel') {
        logger.warn(
          { sourceGroup, reaction },
          'Rejected agent attempt to fire orchestrator-only reaction',
        );
        break;
      }
      try {
        await deps.reactToActiveTurn(sourceGroup, reaction);
      } catch (err) {
        logger.debug(
          { sourceGroup, reaction, err: (err as Error).message },
          'reactToActiveTurn failed (non-fatal)',
        );
      }
      break;
    }

    case 'send_file': {
      if (!deps.sendFile) {
        logger.debug('send_file received but dep not wired');
        break;
      }
      const { filePath, caption, threadTs } = data;
      if (!filePath) {
        logger.warn({ sourceGroup }, 'Invalid send_file: missing filePath');
        break;
      }
      // Resolve source group → chatJid (agent sends to its own chat).
      let chatJid: string | undefined;
      for (const [jid, g] of Object.entries(registeredGroups)) {
        if (g.folder === sourceGroup) {
          chatJid = jid;
          break;
        }
      }
      if (!chatJid) {
        logger.warn({ sourceGroup }, 'send_file: no chat for source group');
        break;
      }
      const hostPath = containerPathToHost(filePath, sourceGroup);
      if (!hostPath) {
        logger.warn(
          { sourceGroup, filePath },
          'send_file: rejected path (must be under /workspace/group/, no ..)',
        );
        break;
      }
      // Size + existence check.
      let size = 0;
      try {
        const st = fs.statSync(hostPath);
        if (!st.isFile()) {
          logger.warn({ hostPath }, 'send_file: path is not a regular file');
          break;
        }
        size = st.size;
      } catch (err) {
        logger.warn(
          { hostPath, err: (err as Error).message },
          'send_file: file not found',
        );
        break;
      }
      if (size > SEND_FILE_SIZE_LIMIT) {
        logger.warn(
          { hostPath, size, limit: SEND_FILE_SIZE_LIMIT },
          'send_file: exceeds size limit',
        );
        break;
      }
      try {
        await deps.sendFile(chatJid, hostPath, {
          caption: typeof caption === 'string' ? caption : undefined,
          threadId: typeof threadTs === 'string' ? threadTs : undefined,
        });
        logger.info(
          { sourceGroup, chatJid, hostPath, size },
          'send_file: dispatched',
        );
      } catch (err) {
        logger.warn(
          { sourceGroup, hostPath, err: (err as Error).message },
          'send_file: channel dispatch failed',
        );
      }
      break;
    }

    case 'get_usage_metrics': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized get_usage_metrics: main only',
        );
        break;
      }
      const requestId = data.requestId;
      if (typeof requestId !== 'string' || !requestId) {
        logger.warn({ sourceGroup }, 'get_usage_metrics: missing requestId');
        break;
      }
      const targetFolder =
        typeof data.target_group_folder === 'string'
          ? data.target_group_folder
          : sourceGroup;
      const aggregate =
        data.aggregate_by === 'day' ||
        data.aggregate_by === 'session' ||
        data.aggregate_by === 'group' ||
        data.aggregate_by === 'none'
          ? data.aggregate_by
          : 'day';
      try {
        const rows = queryTurnMetrics({
          group_folder: targetFolder || undefined,
          since: typeof data.since === 'string' ? data.since : undefined,
          until: typeof data.until === 'string' ? data.until : undefined,
          aggregate_by: aggregate,
          limit: typeof data.limit === 'number' ? data.limit : undefined,
        });
        // Write the response where the MCP tool expects it.
        const responseDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'responses',
        );
        fs.mkdirSync(responseDir, { recursive: true });
        const responsePath = path.join(responseDir, `${requestId}.json`);
        fs.writeFileSync(
          responsePath,
          JSON.stringify({ rows, aggregate }, null, 2),
        );
        logger.debug(
          { sourceGroup, requestId, rowCount: rows.length },
          'get_usage_metrics: response written',
        );
      } catch (err) {
        logger.warn(
          { sourceGroup, err: (err as Error).message },
          'get_usage_metrics failed',
        );
      }
      break;
    }

    case 'memory_search':
    case 'memory_reindex': {
      // Resolve tier from the source group's containerConfig.
      const sourceGroupRecord = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      const tier: MemoryTier = sourceGroupRecord?.isMain
        ? 'main'
        : sourceGroupRecord?.containerConfig?.trusted
          ? 'trusted'
          : 'untrusted';
      const requestId = data.requestId;
      if (typeof requestId !== 'string' || !requestId) {
        logger.warn(
          { sourceGroup, type: data.type },
          'memory_*: missing requestId',
        );
        break;
      }
      const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
      fs.mkdirSync(responseDir, { recursive: true });
      const responsePath = path.join(responseDir, `${requestId}.json`);
      const writeResp = (payload: object): void => {
        try {
          fs.writeFileSync(responsePath, JSON.stringify(payload));
        } catch (err) {
          logger.warn(
            { sourceGroup, requestId, err: (err as Error).message },
            'memory_*: failed to write response',
          );
        }
      };

      try {
        if (data.type === 'memory_search') {
          const query = typeof data.query === 'string' ? data.query : '';
          if (!query) {
            writeResp({ ok: false, error: 'query required' });
            break;
          }
          // Untrusted reads only its own group; trusted/main also read global.
          const scopes: MemoryScope[] = ['group'];
          if (tier !== 'untrusted') scopes.push('global');
          const k = typeof data.k === 'number' ? Math.min(data.k, 50) : 10;
          const hits = await searchChunks(sourceGroup, query, {
            k,
            scope: scopes,
          });
          writeResp({
            ok: true,
            data: { hits, scopes_searched: scopes, tier },
          });
        } else if (data.type === 'memory_reindex') {
          const partial = data.partial !== false; // default true
          // Translate container paths the agent naturally passes
          // (`/workspace/group/...`, `/workspace/global/...`) into host paths
          // before reindexGroup compares against MEMORY_SOURCES roots.
          // Already-host paths pass through unchanged. Without this,
          // every filePath argument from inside a container fails the
          // indexer's `startsWith(root + sep)` check and the call returns
          // filesIndexed=0, filesSkipped=0 — a silent no-op.
          const rawFilePath =
            typeof data.filePath === 'string' && data.filePath
              ? data.filePath
              : undefined;
          const filePath = rawFilePath
            ? memoryFilePathToHost(rawFilePath, sourceGroup)
            : undefined;
          if (rawFilePath && !filePath) {
            writeResp({
              ok: false,
              error:
                `Unrecognised filePath shape: ${rawFilePath}. ` +
                `Use a container path (/workspace/group/... or /workspace/global/...) ` +
                `or an absolute host path. Omit filePath for a partial reindex of all sources.`,
            });
            break;
          }
          const stats = await reindexGroup(sourceGroup, {
            partial,
            filePath: filePath ?? undefined,
          });
          writeResp({ ok: true, data: stats });
        }
      } catch (err) {
        logger.warn(
          { sourceGroup, type: data.type, err: (err as Error).message },
          'memory_* handler failed',
        );
        writeResp({ ok: false, error: (err as Error).message });
      }
      break;
    }

    case 'list_recent_messages':
    case 'list_threads':
    case 'get_thread':
    case 'search_messages': {
      // Resolve the source group's chat_jid — tools are scoped to the
      // calling group's own channel only. No chat_jid arg from the agent;
      // we look it up from the registered_groups record.
      const sourceGroupRecord = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      const requestId = data.requestId;
      if (typeof requestId !== 'string' || !requestId) {
        logger.warn(
          { sourceGroup, type: data.type },
          'history tool: missing requestId',
        );
        break;
      }
      const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
      fs.mkdirSync(responseDir, { recursive: true });
      const responsePath = path.join(responseDir, `${requestId}.json`);
      const writeResp = (payload: object): void => {
        try {
          fs.writeFileSync(responsePath, JSON.stringify(payload));
        } catch (err) {
          logger.warn(
            { sourceGroup, requestId, err: (err as Error).message },
            'history tool: failed to write response',
          );
        }
      };

      const sourceJid = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === sourceGroup,
      )?.[0];
      if (!sourceGroupRecord || !sourceJid) {
        writeResp({ ok: false, error: 'source group not registered' });
        break;
      }

      try {
        if (data.type === 'list_recent_messages') {
          const messages = listRecentMessages(sourceJid, {
            limit: typeof data.limit === 'number' ? data.limit : undefined,
            scope: data.message_scope === 'all' ? 'all' : 'root',
            since: typeof data.since === 'string' ? data.since : undefined,
          });
          writeResp({ ok: true, data: { messages } });
        } else if (data.type === 'list_threads') {
          const threads = listThreads(sourceJid, {
            limit: typeof data.limit === 'number' ? data.limit : undefined,
            since: typeof data.since === 'string' ? data.since : undefined,
          });
          writeResp({ ok: true, data: { threads } });
        } else if (data.type === 'get_thread') {
          const threadId =
            typeof data.thread_id === 'string' ? data.thread_id : '';
          if (!threadId) {
            writeResp({ ok: false, error: 'thread_id required' });
            break;
          }
          const result = getThreadMessages(sourceJid, threadId, ASSISTANT_NAME);
          writeResp({ ok: true, data: result });
        } else if (data.type === 'search_messages') {
          const query = typeof data.query === 'string' ? data.query : '';
          if (!query.trim()) {
            writeResp({ ok: false, error: 'query required' });
            break;
          }
          const result = searchMessages(sourceJid, query, {
            limit: typeof data.limit === 'number' ? data.limit : undefined,
            since: typeof data.since === 'string' ? data.since : undefined,
            sender: typeof data.sender === 'string' ? data.sender : undefined,
            // Group by thread for any source channel — non-threading channels
            // naturally return everything in the `root` bucket since their
            // messages have thread_id null/equal-to-id.
            groupedByThread: true,
          });
          writeResp({ ok: true, data: result });
        }
      } catch (err) {
        logger.warn(
          { sourceGroup, type: data.type, err: (err as Error).message },
          'history tool handler failed',
        );
        writeResp({ ok: false, error: (err as Error).message });
      }
      break;
    }

    case 'model_exhausted': {
      const model = typeof data.model === 'string' ? data.model : null;
      if (!model) {
        logger.warn({ data }, 'Invalid model_exhausted: missing model');
        break;
      }
      const resetsAt =
        typeof data.resets_at === 'string' && data.resets_at
          ? data.resets_at
          : null;
      // If no reset time given, mark exhausted for a default TTL so the
      // next spawn skips this model; conservative — 30 min.
      const effectiveResets =
        resetsAt ?? new Date(Date.now() + 30 * 60_000).toISOString();
      markExhausted(model, effectiveResets);
      logger.warn(
        {
          sourceGroup,
          model,
          resetsAt: effectiveResets,
          rateLimitType: data.rate_limit_type,
        },
        'Model exhaustion reported from agent-runner',
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
