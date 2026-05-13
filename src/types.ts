export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  trusted?: boolean; // Trusted groups get elevated access (default: false)
  // Switch for the host-side MCP gateway. When true, the agent-runner
  // registers the in-container gateway-client shim, which forwards calls to
  // the host gateway over HTTP. Categories and tier ACL are configured in
  // groups/_gateway/acl.json. Default false (no external MCPs).
  useMcpGateway?: boolean;
  // BENCH ONLY. When true on an oneshot, the parent group's mcp-secrets.json
  // is mounted (read-only) into the oneshot's /workspace/group/ — making
  // direct-spawn MCPs find their credentials. Defeats the security boundary
  // step 1 established by shadowing /workspace/parent/mcp-secrets.json, so:
  //   - admin scope only (rejected if not main),
  //   - never set in production code paths,
  //   - only spawn_oneshot from a host-side bench script can set this.
  // See docs/MCP-GATEWAY-BENCH-PLAN.md "Round 2".
  benchPassthroughParentSecrets?: boolean;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  /**
   * Thread to reply into when the task fires. Captured from the scheduling
   * agent's defaultThreadId. NULL/empty = post at channel root (typical for
   * recurring tasks or once-tasks where completion time is uncertain).
   * Cross-group target_group_jid always sets this to null at MCP-tool time.
   */
  thread_id?: string | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    threadId?: string,
    replyToMessageId?: string,
  ): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: progress reactions. Channels that can react implement these.
  // The reaction is a canonical name (e.g. 'working', 'done'); each channel
  // maps it to its own emoji/shortcode. See src/reactions/vocabulary.ts.
  addReaction?(
    jid: string,
    messageId: string,
    reaction: import('./reactions/vocabulary.js').CanonicalReaction,
  ): Promise<void>;
  supportsReactions?(jid: string): boolean;
  // Optional: delete a message in the chat. Slack: chat.delete (only the
  // bot's own messages; no admin scope required for the bot's own posts).
  // Channels that don't support deletion omit this method.
  deleteMessage?(jid: string, messageId: string): Promise<void>;
  // Optional: upload a file to the chat. Channels that support it implement
  // it. `filePath` is a host-side absolute path; the orchestrator is
  // responsible for translating from the agent's container path before
  // calling this.
  sendFile?(
    jid: string,
    filePath: string,
    opts?: { caption?: string; threadId?: string },
  ): Promise<void>;
  // Optional: agent-team / swarm send. A subagent's send_message call with
  // a `sender` parameter routes here so the channel can deliver the message
  // from a per-role identity (e.g. a renamed bot in Telegram). Channels
  // without swarm support omit this — the orchestrator falls back to the
  // regular sendMessage with a "[Sender] " prefix.
  sendPoolMessage?(
    jid: string,
    text: string,
    sender: string,
    groupFolder: string,
    iconEmoji?: string,
    threadId?: string,
  ): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
