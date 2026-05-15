---
name: windows-ops
description: Run, maintain, and troubleshoot NanoClaw on Windows. Covers PM2 service management, port-conflict and orphan-process recovery, log locations, build pipeline through Docker Desktop, and the PowerShell-vs-bash conventions specific to this install. Use for "restart nanoclaw", "check status", "view logs", "rebuild container", "free port 3001/3002", or any Windows-specific operational issue.
---

# NanoClaw on Windows

NanoClaw on Windows runs under PM2 as the service supervisor (not launchd/systemd, which the upstream docs reference for macOS/Linux). Containers run under Docker Desktop. Both Git Bash and PowerShell are available — see the conventions section for which to use when.

## Quick reference

| Action | Command |
|---|---|
| Service status | `pm2 status` |
| Restart service | `pm2 restart nanoclaw` (⚠️ see "Restart safety" below) |
| Stop service | `pm2 stop nanoclaw` |
| Start service | `pm2 start nanoclaw` |
| Reload config | `pm2 startOrReload ecosystem.config.cjs` |
| Tail real logs | `tail -f data/nanoclaw.log` (bash) or `Get-Content -Wait data/nanoclaw.log` (PowerShell) |
| Container build | `./container/build.sh` (Git Bash; needs Docker Desktop running) |
| TS build | `npm run build` |
| Dev mode | `npm run dev` (hot reload, no PM2) |
| Check live containers | `docker ps` |

## Service management with PM2

PM2 is the supervisor. The process name is `nanoclaw`. Config is in `ecosystem.config.cjs` if present.

```bash
pm2 status              # show process, uptime, restarts, memory
pm2 logs nanoclaw       # tail pm2's stdout/stderr capture
pm2 restart nanoclaw    # full restart (SIGTERM → respawn)
pm2 stop nanoclaw       # stop without removing from list
pm2 delete nanoclaw     # remove from list (need `pm2 start` to bring back)
pm2 save                # persist current list across reboots
```

`pm2 logs nanoclaw` is incomplete — pm2 only captures what nanoclaw writes to stdout/stderr at the supervisor level. The **real** log is `data/nanoclaw.log` (see Logs section). Always tail that file rather than relying on pm2's capture.

## PM2 launcher script (required on Windows)

`dist/index.js` is ESM. PM2's `ProcessContainerFork` cannot run it directly — it loads the module but `main()` never fires (NanoClaw guards `main()` with an `isDirectRun` check that compares `process.argv[1]` against `import.meta.url`; under PM2 those don't match because PM2 wraps the script). Symptoms: `pm2 status` shows the process **online** with high memory (~90 MB) but `data/nanoclaw.log` never grows and no port gets bound. PM2's own logs (`~/.pm2/logs/nanoclaw-*.log`) stay empty. Easy to misread as a hang.

The fix is a tiny `.cjs` launcher that PM2 *can* `require()`. It sets env, spoofs `argv[1]`, then dynamic-imports the ESM:

```js
// start-nanoclaw.cjs (project root)
const path = require('path');
const entry = path.join(__dirname, 'dist', 'index.js');
process.argv[1] = entry;  // make isDirectRun match
import(`file://${entry.replace(/\\/g, '/')}`).catch((err) => {
  process.stderr.write(`failed: ${err?.stack || err}\n`);
  process.exit(1);
});
```

Then in `ecosystem.config.cjs`:

```js
module.exports = {
  apps: [{
    name: 'nanoclaw',
    script: 'start-nanoclaw.cjs',
    cwd: 'C:\\path\\to\\nanoclaw',
    exec_mode: 'fork',
    autorestart: true,
    // env: { ... port overrides if running side-by-side with another instance }
  }],
};
```

**Don't use a `.cmd` wrapper.** It also works, but PM2 spawns it via `cmd.exe /c …` which keeps a visible console window open for the lifetime of the process. The `.cjs` route runs as a single hidden node process.

A `.sh` wrapper through Git Bash (the `nc-wrapper.sh` pattern some installs use) is fine — Git Bash on Windows runs without a Win32 console — but `.cjs` is the most portable and dependency-free option.

## ⚠️ Restart safety

`pm2 restart` sends SIGTERM to the orchestrator. The orchestrator does NOT gracefully drain in-flight agent containers — they get killed mid-turn. Users in active conversations lose their replies.

**Always before `pm2 restart`:**

```bash
docker ps --filter "ancestor=nanoclaw-agent:latest" --format "{{.Names}} {{.RunningFor}}"
```

If any containers are listed and you don't have explicit user approval to restart now, **ask before proceeding**. Recovery system (`/add-recovery-system`) will re-trigger interrupted turns on next boot, but the user still sees disruption.

## Port conflicts and orphan processes

Two ports nanoclaw binds on the host:
- **3001** — IPC HTTP server (host ↔ container)
- **3002** — MCP gateway HTTP server

If the orchestrator crashes ungracefully, a child `node dist/index.js` can survive holding these ports. PM2 then crash-loops trying to bind. Symptom: `pm2 status` shows nanoclaw `errored`, restart count climbing fast, and `data/nanoclaw.log` records `EADDRINUSE` on 3001 or 3002.

**Find the orphan (PowerShell — use this, not bash):**

```powershell
Get-NetTCPConnection -LocalPort 3001,3002 -ErrorAction SilentlyContinue |
  Select-Object LocalPort, OwningProcess, State |
  ForEach-Object {
    $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    [PSCustomObject]@{ Port=$_.LocalPort; PID=$_.OwningProcess; Process=$proc.ProcessName; CmdLine=(Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").CommandLine }
  }
```

**Kill the orphan:**

```powershell
Stop-Process -Id <PID> -Force
```

Then `pm2 restart nanoclaw`. Do not use `taskkill` from bash — the path-handling around `node.exe` is unreliable.

## Logs

| File | What | When to look |
|---|---|---|
| `data/nanoclaw.log` | Real orchestrator log (host-side, structured) | First place to check for anything |
| `data/nanoclaw.error.log` | Host-side errors only | Crashes, startup failures |
| `groups/{folder}/logs/container-*.log` | Per-turn container run logs | Container failures, agent-side issues |
| `~/.pm2/logs/nanoclaw-*.log` | PM2's stdout/stderr capture | Supervisor-level issues (process exits, signal handling) |
| `logs/setup.log` | Setup-time verbose log | First-time setup debugging |

`LOG_LEVEL=debug` in `.env` enables verbose orchestrator logging (mounts, container args, container stderr).

## Build pipeline

NanoClaw has two builds:

**TypeScript build (host):**
```bash
npm run build           # tsc → dist/
```

**Container image build (agent runtime):**
```bash
./container/build.sh    # docker build → nanoclaw-agent:latest
```

The container build script is bash; run it from Git Bash, not PowerShell. It requires Docker Desktop to be running. If Docker is not running:

```powershell
# Check
docker info
# Start (PowerShell — Docker Desktop ships a startup shortcut)
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
```

⚠️ **Container build cache gotcha** (from project CLAUDE.md): the buildkit caches build context aggressively and `--no-cache` alone does NOT invalidate COPY steps. To force a clean rebuild:

```bash
docker buildx prune -f
./container/build.sh
```

## PowerShell vs Git Bash

Both are available. Convention:

| Use PowerShell for | Use Git Bash for |
|---|---|
| Windows-native operations: `Get-NetTCPConnection`, `Get-Process`, `Stop-Process` | Shell scripts: `./container/build.sh`, `./setup.sh` |
| Service manipulation outside PM2 | `git`, `npm`, `node`, `npx` commands |
| Reading `%APPDATA%` paths (use `$env:APPDATA`) | `tail -f`, `grep`, `find` |
| Anything involving paths with spaces (better quoting story) | Multi-line `&&` chains |

Forward slashes work in both shells for filesystem paths in node/git/docker commands. Backslashes are only required for `cmd.exe` shell internals (rare).

## First-time setup on Windows

If installing fresh:

1. **Node.js 22**: `winget install OpenJS.NodeJS.LTS` (or 22 via volta/nvm-windows).
2. **PM2**: `npm install -g pm2 pm2-windows-startup` then `pm2-startup install` so PM2 survives reboot.
3. **Docker Desktop**: `winget install Docker.DockerDesktop` then enable WSL2 backend.
4. **Git for Windows**: `winget install Git.Git` (includes Git Bash).
5. **Project bootstrap**: from Git Bash in the repo root, run `bash setup.sh` (this is the cross-platform entry point — the regular `/setup` skill takes it from there).

After `npm run build && ./container/build.sh`, create a `start-nanoclaw.cjs` launcher and `ecosystem.config.cjs` per "PM2 launcher script (required on Windows)" above — PM2 cannot run `dist/index.js` directly. Then:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

## Common Windows-specific issues

### Symptom: `pm2 status` shows nanoclaw repeatedly restarting

Almost always orphan node holding 3001/3002. See "Port conflicts" above.

### Symptom: `pm2 status` shows nanoclaw `online` but no log, no port bound

PM2 is running an ESM script (`dist/index.js`) directly instead of through the `.cjs` launcher. The fork loads the module but `main()` never fires — see "PM2 launcher script (required on Windows)" above. Memory will sit around 90 MB, `data/nanoclaw.log` will be untouched after restart, and `Get-NetTCPConnection -LocalPort 3001,3002` will show nothing in `Listen` state. Fix: switch the `script` in `ecosystem.config.cjs` to your `start-nanoclaw.cjs` wrapper, then `pm2 delete nanoclaw && pm2 start ecosystem.config.cjs && pm2 save`.

### Symptom: PM2 launcher works but a `cmd.exe` console window stays open

The launcher is a `.cmd` file. PM2 spawns `cmd.exe /c …` which keeps a visible console for the process lifetime. Replace with the `.cjs` launcher — same behavior, hidden process. See "PM2 launcher script (required on Windows)".

### Trap: stopping containers across multi-checkout installs

Container names follow `nanoclaw-<group-folder>-<timestamp>` and don't include any checkout-specific prefix. If two NanoClaw checkouts run on the same host (e.g. main + reserve, both registered with a `telegram_main` group folder), `docker ps --filter name=nanoclaw-` returns containers from BOTH. A blanket `xargs docker stop` will kill the other checkout's in-flight turns. Recovery (`/add-recovery-system`) re-triggers them, but the user notices the disruption.

Safer commands when you only want THIS checkout's containers:

```bash
# Match a unique substring of the group folder for this checkout only:
docker ps --filter name=nanoclaw-telegram-main- --format '{{.Names}}'  # still ambiguous if both checkouts share the folder

# Better: read the running containers' label/env to confirm the host cwd, or
# just operate by exact name:
docker ps --filter name=nanoclaw- --format '{{.Names}}\t{{.Command}}\t{{.CreatedAt}}'
# then docker stop <one specific name>
```

Long-term fix is to teach `container-runner.ts` to prefix the container name with a per-checkout label (e.g. cwd hash). Until then, treat the blanket stop as "ask first".

### Symptom: a Docker console window flashes/lingers on every agent turn

`docker run`, `docker info`, `docker ps`, `docker stop` are console-subsystem executables on Windows. When NanoClaw spawns them via `child_process.spawn` / `execSync` from a console-less parent (PM2's hidden node, Cursor's integrated runner, etc.), Windows allocates a fresh console for each call — visible as a popup window for the lifetime of `docker run` and a flash for the short calls.

Fix: pass `windowsHide: true` to every Node `spawn`/`execSync`/`execFile` call that invokes the container runtime. In NanoClaw the touch points are:

- `src/container-runner.ts` — long-running `docker run` for each turn (the obvious culprit).
- `src/container-runtime.ts` — `docker info`, `docker ps --filter name=nanoclaw-`, `docker stop -t 3 <name>` (the periodic flashes).

```ts
spawn(CONTAINER_RUNTIME_BIN, args, { stdio: [...], windowsHide: true });
execSync(`${CONTAINER_RUNTIME_BIN} info`, { stdio: 'pipe', windowsHide: true });
```

After patching, `npm run build` + `pm2 restart nanoclaw` (subject to "Restart safety") and the windows are gone — the docker child processes still run, just without an attached console. `windowsHide` is a no-op on macOS/Linux, so the patch is safe to upstream.

### Symptom: `./container/build.sh` fails with "permission denied"

The script needs execute bit. Git for Windows usually sets this on checkout, but if not:
```bash
git update-index --chmod=+x container/build.sh
```

### Symptom: MCP gateway returns `command not found` for an MCP binary

The gateway runs on the host (Windows), so the MCP binary must be findable from PowerShell's `$env:PATH`, not just bash. Windows installs npm globals to `%APPDATA%\npm\` which is usually on PATH but may not be inside a fresh terminal. Verify:

```powershell
where my-mcp-binary
```

For `.cmd` shims that Node `spawn` can't find, register the JS entry directly in `groups/_gateway/acl.json`:
```json
"command": "node",
"args": ["${env:APPDATA}/npm/node_modules/<pkg>/dist/index.js"]
```

### Symptom: containers can't reach the host on `host.docker.internal`

Docker Desktop on Windows resolves `host.docker.internal` automatically. If it doesn't, check Docker Desktop is current and WSL2 backend is enabled.

### Symptom: line-ending warnings on `git add` / `git commit`

Normal — Git normalizes LF↔CRLF per `core.autocrlf`. Doesn't affect runtime. If it causes diffs to look noisy, set `git config core.autocrlf input` repo-wide.

### Symptom: `tail -f` in PowerShell

Native PowerShell has `Get-Content -Wait <file>`. From Git Bash, `tail -f data/nanoclaw.log` works as expected.

## Maintenance routines

**Weekly (or when feels slow):**

```bash
docker system prune -f          # reclaim stopped containers, dangling images
docker buildx prune --filter "until=168h" -f   # reclaim build cache > 7 days old
```

**Monthly:**

```bash
# Vacuum the SQLite store to compact after lots of deletes/updates
sqlite3 store/messages.db "VACUUM;"
# Rotate the orchestrator log (PM2 won't do this automatically)
mv data/nanoclaw.log data/nanoclaw.log.$(date +%Y%m%d) && pm2 reload nanoclaw
```

**After upstream pulls** (`/update-nanoclaw` covers this, but the manual path):

```bash
npm install
npm run build
./container/build.sh    # only if container/ changed
pm2 restart nanoclaw    # ⚠️ see Restart safety
```
