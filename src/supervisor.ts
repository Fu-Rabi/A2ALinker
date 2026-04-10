import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { getDefaultRenderOptions, RenderOptions, renderUiEvent, SupervisorUiEvent } from './supervisor-ui';

export type SupervisorMode = 'host' | 'join' | 'listen';
export type ConversationRole = 'host' | 'join';

export interface SupervisorOptions {
  mode: SupervisorMode;
  agentLabel: string;
  runnerCommand: string;
  goal?: string;
  inviteCode?: string;
  listenerCode?: string;
  headless?: boolean;
  scriptDir?: string;
  sessionRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: SupervisorLogger;
  plainMode?: boolean;
  timestampEnabled?: boolean;
  terminalWidth?: number;
  colorEnabled?: boolean;
}

interface SupervisorLogger {
  info: (...args: string[]) => void;
  error: (...args: string[]) => void;
}

interface MutableSupervisorOptions extends SupervisorOptions {
  headless: boolean;
  scriptDir: string;
  sessionRoot: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logger: SupervisorLogger;
  renderOptions: RenderOptions;
}

interface SessionState {
  sessionId: string;
  sessionDir: string;
  transcriptPath: string;
  metadataPath: string;
  role: ConversationRole;
  mode: SupervisorMode;
  agentLabel: string;
  goal: string | null;
}

interface ConnectResult {
  role: ConversationRole;
  status: 'ready' | 'waiting';
  code?: string;
  headless: boolean;
}

type LoopEvent =
  | {
      type: 'message';
      signal: 'OVER' | 'STANDBY' | null;
      speaker: string | null;
      body: string;
    }
  | {
      type: 'system';
      body: string;
      kind: 'joined' | 'closed' | 'paused' | 'alert' | 'other';
    }
  | { type: 'room_alive'; lastSeenMs: number }
  | { type: 'room_closed' }
  | { type: 'ping_failed' };

export function buildRunnerPrompt(input: {
  agentLabel: string;
  role: ConversationRole;
  goal: string | null;
  incomingMessage: string;
}): string {
  const lines = [
    `You are ${input.agentLabel}, connected to an A2A Linker session as the ${input.role.toUpperCase()}.`,
    `Respond to the partner message below.`,
    `Keep the reply concise and task-focused.`,
    `Your final line must end with either [OVER] if you expect a reply or [STANDBY] if no reply is needed.`,
    '',
  ];

  if (input.goal) {
    lines.push('Session goal:', input.goal, '');
  }

  lines.push('Partner message:', input.incomingMessage, '', 'Reply with message text only.');
  return lines.join('\n');
}

export function normalizeSupervisorReply(rawReply: string): string {
  const reply = rawReply.trim();
  if (!reply) {
    throw new Error('Runner returned an empty reply.');
  }
  if (/\[(OVER|STANDBY)\]\s*$/i.test(reply)) {
    return reply;
  }
  return `${reply} [OVER]`;
}

export function parseLoopEvent(output: string): LoopEvent {
  const trimmed = stripDeliveredPrefix(output).trim();

  if (trimmed.startsWith('TIMEOUT_ROOM_ALIVE')) {
    const match = trimmed.match(/last_seen_ms=(\d+)/);
    return {
      type: 'room_alive',
      lastSeenMs: match ? Number(match[1]) : 0,
    };
  }

  if (trimmed.startsWith('TIMEOUT_ROOM_CLOSED')) {
    return { type: 'room_closed' };
  }

  if (trimmed.startsWith('TIMEOUT_PING_FAILED')) {
    return { type: 'ping_failed' };
  }

  if (!trimmed.startsWith('MESSAGE_RECEIVED')) {
    throw new Error(`Unsupported loop output: ${trimmed}`);
  }

  const systemBody = extractSystemBody(trimmed);
  if (systemBody) {
    return {
      type: 'system',
      body: systemBody,
      kind: classifySystemMessage(systemBody),
    };
  }

  const headerMatch = trimmed.match(/┌─\s+([^\n\[]+?)(?:\s+\[(OVER|STANDBY)\])?\n/);
  const speaker = headerMatch?.[1]?.trim() ?? null;
  const signal = (headerMatch?.[2] as 'OVER' | 'STANDBY' | undefined) ?? null;
  const bodyMatches = [...trimmed.matchAll(/^│ ?(.*)$/gm)];
  const bodyLines = bodyMatches
    .map((match, index) => (index === 0 && match[1] === '' ? null : match[1] ?? ''))
    .filter((line): line is string => line !== null);
  const body = bodyLines.join('\n').trim();

  return {
    type: 'message',
    signal,
    speaker,
    body,
  };
}

function stripDeliveredPrefix(output: string): string {
  return output.replace(/^(?:DELIVERED\s*\n)+/, '');
}

function emitUiEvent(options: MutableSupervisorOptions, event: SupervisorUiEvent): void {
  const rendered = renderUiEvent(event, options.renderOptions);
  if (event.type === 'notice' && event.level === 'error') {
    options.logger.error(rendered);
    return;
  }
  options.logger.info(rendered);
}

function emitLoopEvent(options: MutableSupervisorOptions, role: ConversationRole, event: LoopEvent): void {
  switch (event.type) {
    case 'message':
      emitUiEvent(options, {
        type: 'message',
        direction: 'inbound',
        speaker: event.speaker ?? 'Agent-unknown',
        signal: event.signal,
        body: event.body,
      });
      return;
    case 'system':
      emitSystemEvent(options, role, event);
      return;
    case 'room_alive':
      emitUiEvent(options, {
        type: 'notice',
        level: 'info',
        label: 'WAITING',
        detail: 'Partner is still connected but inactive.',
        layout: 'line',
        meta: [`last_seen_ms=${event.lastSeenMs}`],
      });
      return;
    case 'room_closed':
      emitUiEvent(options, {
        type: 'notice',
        level: 'warn',
        label: 'SESSION CLOSED',
        detail: 'The broker reported that the session has ended.',
        layout: 'card',
      });
      return;
    case 'ping_failed':
      emitUiEvent(options, {
        type: 'notice',
        level: 'error',
        label: 'RETRYING',
        detail: 'Relay ping failed. Retrying automatically.',
        layout: 'line',
      });
      return;
  }
}

function emitSystemEvent(
  options: MutableSupervisorOptions,
  role: ConversationRole,
  event: Extract<LoopEvent, { type: 'system' }>,
): void {
  if (event.kind === 'joined') {
    emitUiEvent(options, {
      type: 'session',
      stage: 'live',
      title: 'A2A LINKER SESSION LIVE',
      agentLabel: options.agentLabel,
      role,
      mode: options.mode,
      headless: options.headless,
      goal: options.goal ?? null,
      detail: event.body.replace(/^\[SYSTEM\]:\s*/, ''),
    });
    return;
  }

  if (event.kind === 'paused') {
    emitUiEvent(options, {
      type: 'notice',
      level: 'warn',
      label: 'SESSION PAUSED',
      detail: event.body.replace(/^\[SYSTEM\]:\s*/, ''),
      layout: 'card',
    });
    return;
  }

  if (event.kind === 'closed') {
    emitUiEvent(options, {
      type: 'notice',
      level: 'warn',
      label: 'SESSION CLOSED',
      detail: event.body.replace(/^\[SYSTEM\]:\s*/, ''),
      layout: 'card',
    });
    return;
  }

  if (event.kind === 'alert') {
    emitUiEvent(options, {
      type: 'notice',
      level: 'error',
      label: 'SYSTEM ALERT',
      detail: event.body.replace(/^\[SYSTEM ALERT\]:\s*/, ''),
      layout: 'card',
    });
    return;
  }

  emitUiEvent(options, {
    type: 'notice',
    level: 'info',
    label: 'SYSTEM',
    detail: event.body.replace(/^\[SYSTEM\]:\s*/, ''),
    layout: 'line',
  });
}

function emitReply(options: MutableSupervisorOptions, agentLabel: string, reply: string): void {
  const { signal, body } = splitReply(reply);
  emitUiEvent(options, {
    type: 'message',
    direction: 'outbound',
    speaker: agentLabel,
    signal,
    body,
  });
}

export async function runSupervisor(options: SupervisorOptions): Promise<SessionState> {
  const resolved = resolveOptions(options);
  const session = createSessionState(resolved);
  let shouldCleanupSession = false;

  emitUiEvent(resolved, {
    type: 'session',
    stage: 'starting',
    title: 'A2A LINKER CONNECTING',
    agentLabel: resolved.agentLabel,
    role: resolved.mode === 'listen' ? 'join' : resolved.mode,
    mode: resolved.mode,
    headless: resolved.headless,
    goal: resolved.goal ?? null,
    detail: 'Initializing local supervisor and connecting to the relay.',
  });

  writeSessionMetadata(session, {
    status: 'starting',
    pid: String(process.pid),
  });

  const cleanup = installSignalCleanup(resolved, session);

  try {
    const connect = await connectSession(resolved, session);
    session.role = connect.role;
    resolved.headless = connect.headless;
    writeSessionMetadata(session, {
      status: 'connected',
      role: connect.role,
      code: connect.code ?? null,
    });

    if (connect.code) {
      emitUiEvent(resolved, {
        type: 'session',
        stage: 'code-ready',
        title: connect.role === 'join' ? 'LISTENER READY' : 'INVITE READY',
        agentLabel: resolved.agentLabel,
        role: connect.role,
        mode: resolved.mode,
        headless: connect.headless,
        goal: resolved.goal ?? null,
        code: connect.code,
        detail:
          connect.role === 'join'
            ? 'Share this listener code with the host and keep this supervisor running.'
            : 'Share this invite code with the partner to establish the session.',
      });
    }

    if (connect.status === 'waiting') {
      emitUiEvent(resolved, {
        type: 'notice',
        level: 'info',
        label: 'WAITING',
        detail:
          connect.role === 'host'
            ? 'Session is ready. Waiting for partner to connect.'
            : 'Listener is ready. Waiting for the host to redeem the code.',
        layout: 'line',
      });
    } else {
      emitUiEvent(resolved, {
        type: 'session',
        stage: 'live',
        title: 'A2A LINKER SESSION LIVE',
        agentLabel: resolved.agentLabel,
        role: connect.role,
        mode: resolved.mode,
        headless: connect.headless,
        goal: resolved.goal ?? null,
        detail: 'Partner connected. Session is live.',
      });
    }

    let nextEvent: LoopEvent;
    if (connect.role === 'host') {
      nextEvent = await getInitialHostEvent(resolved, session, connect.status);
    } else {
      nextEvent = await runLoopScript(resolved, session, connect.role);
    }

    for (;;) {
      writeSessionMetadata(session, {
        status: 'waiting',
        lastEvent: nextEvent.type,
      });
      emitLoopEvent(resolved, session.role, nextEvent);

      if (nextEvent.type === 'room_closed') {
        writeSessionMetadata(session, { status: 'closed', lastEvent: nextEvent.type });
        shouldCleanupSession = true;
        break;
      }

      if (nextEvent.type === 'ping_failed') {
        writeSessionMetadata(session, { status: 'retrying', lastEvent: nextEvent.type });
        await sleep(5_000);
        nextEvent = await runLoopScript(resolved, session, session.role);
        continue;
      }

      if (nextEvent.type === 'room_alive') {
        writeSessionMetadata(session, {
          status: 'waiting',
          lastEvent: nextEvent.type,
          lastSeenMs: String(nextEvent.lastSeenMs),
        });
        nextEvent = await runLoopScript(resolved, session, session.role);
        continue;
      }

      if (nextEvent.type === 'system') {
        appendTranscript(session, `SYSTEM:\n${nextEvent.body}\n`);

        if (nextEvent.kind === 'joined' || nextEvent.kind === 'other') {
          nextEvent = await runLoopScript(resolved, session, session.role);
          continue;
        }

        if (nextEvent.kind === 'closed') {
          writeSessionMetadata(session, {
            status: 'closed',
            lastEvent: 'system_closed',
          });
          shouldCleanupSession = true;
          break;
        }

        if (nextEvent.kind === 'paused') {
          writeSessionMetadata(session, {
            status: 'paused',
            lastEvent: 'system_paused',
          });
          nextEvent = await runLoopScript(resolved, session, session.role);
          continue;
        }

        if (nextEvent.kind === 'alert') {
          writeSessionMetadata(session, {
            status: 'paused',
            lastEvent: 'system_alert',
          });
          break;
        }
      }

      if (nextEvent.type !== 'message') {
        throw new Error(`Unexpected supervisor event type: ${nextEvent.type}`);
      }

      appendTranscript(session, `PARTNER (${nextEvent.speaker ?? 'unknown'}):\n${nextEvent.body}\n`);

      if (nextEvent.signal === 'STANDBY') {
        nextEvent = await runLoopScript(resolved, session, session.role);
        continue;
      }

      const prompt = buildRunnerPrompt({
        agentLabel: resolved.agentLabel,
        role: session.role,
        goal: resolved.goal ?? null,
        incomingMessage: nextEvent.body,
      });
      const rawReply = await runRunner(resolved, session, prompt, nextEvent.body);
      const reply = normalizeSupervisorReply(rawReply);
      appendTranscript(session, `${resolved.agentLabel.toUpperCase()}:\n${reply}\n`);
      emitReply(resolved, resolved.agentLabel, reply);
      const { signal } = splitReply(reply);
      writeSessionMetadata(session, {
        status: 'waiting',
        lastReplySignal: signal ?? 'OVER',
      });
      nextEvent = await runLoopScript(resolved, session, session.role, reply);
    }

    return session;
  } finally {
    if (shouldCleanupSession) {
      cleanupLocalSession(resolved, session);
    }
    cleanup();
  }
}

function resolveOptions(options: SupervisorOptions): MutableSupervisorOptions {
  if (!options.agentLabel.trim()) {
    throw new Error('agentLabel is required.');
  }
  if (!options.runnerCommand.trim()) {
    throw new Error('runnerCommand is required.');
  }

  const mode = options.mode;
  if (mode === 'join' && !options.inviteCode) {
    throw new Error('inviteCode is required for join mode.');
  }
  if (mode === 'host' && !options.goal?.trim()) {
    throw new Error('goal is required for host mode.');
  }

  const scriptDir = options.scriptDir ?? path.resolve(process.cwd(), '.agents/skills/a2alinker/scripts');
  const sessionRoot = options.sessionRoot ?? path.join(os.tmpdir(), 'a2a-supervisor');
  const cwd = options.cwd ?? process.cwd();

  return {
    ...options,
    headless: options.headless ?? true,
    scriptDir,
    sessionRoot,
    cwd,
    env: { ...process.env, ...options.env },
    logger: options.logger ?? {
      info: (...args: string[]) => console.log(...args),
      error: (...args: string[]) => console.error(...args),
    },
    renderOptions: getDefaultRenderOptions({
      ...(options.plainMode !== undefined ? { plainMode: options.plainMode } : {}),
      ...(options.timestampEnabled !== undefined ? { timestampEnabled: options.timestampEnabled } : {}),
      ...(options.terminalWidth !== undefined ? { width: options.terminalWidth } : {}),
      ...(options.colorEnabled !== undefined ? { colorEnabled: options.colorEnabled } : {}),
    }),
  };
}

function createSessionState(options: MutableSupervisorOptions): SessionState {
  fs.mkdirSync(options.sessionRoot, { recursive: true });
  const sessionId = `a2a_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const sessionDir = path.join(options.sessionRoot, sessionId);
  fs.mkdirSync(sessionDir, { recursive: false });

  const transcriptPath = path.join(sessionDir, 'transcript.log');
  const metadataPath = path.join(sessionDir, 'session.json');

  const state: SessionState = {
    sessionId,
    sessionDir,
    transcriptPath,
    metadataPath,
    role: options.mode === 'host' ? 'host' : 'join',
    mode: options.mode,
    agentLabel: options.agentLabel,
    goal: options.goal ?? null,
  };

  fs.writeFileSync(transcriptPath, '', 'utf8');
  fs.writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        sessionId,
        agentLabel: options.agentLabel,
        mode: options.mode,
        goal: options.goal ?? null,
      },
      null,
      2,
    ),
    'utf8',
  );

  return state;
}

function writeSessionMetadata(session: SessionState, patch: Record<string, string | null>): void {
  const current = JSON.parse(fs.readFileSync(session.metadataPath, 'utf8')) as Record<string, unknown>;
  const next = {
    ...current,
    updatedAt: new Date().toISOString(),
    ...patch,
  };
  fs.writeFileSync(session.metadataPath, JSON.stringify(next, null, 2), 'utf8');
}

function appendTranscript(session: SessionState, block: string): void {
  fs.appendFileSync(session.transcriptPath, `${block}\n`, 'utf8');
}

async function connectSession(options: MutableSupervisorOptions, session: SessionState): Promise<ConnectResult> {
  switch (options.mode) {
    case 'listen': {
      const result = await runScript(options, 'a2a-listen.sh', [String(options.headless)], session);
      const listenerCode = matchLine(result.stdout, 'LISTENER_CODE:');
      const headless = matchLine(result.stdout, 'HEADLESS_SET:') === 'true';
      if (!listenerCode) {
        throw new Error(`Listener code missing from output:\n${result.stdout}`);
      }
      return { role: 'join', status: 'waiting', code: listenerCode, headless };
    }
    case 'join': {
      const env = {
        ...options.env,
        A2A_INVITE: options.inviteCode ?? '',
      };
      const result = await runScript(options, 'a2a-join-connect.sh', [], session, env);
      const status = matchLine(result.stdout, 'STATUS:');
      const headless = matchLine(result.stdout, 'HEADLESS:') === 'true';
      return {
        role: 'join',
        status: status === '(2/2 connected)' ? 'ready' : 'waiting',
        headless,
      };
    }
    case 'host': {
      const args = options.listenerCode ? [options.listenerCode] : ['', String(options.headless)];
      const result = await runScript(options, 'a2a-host-connect.sh', args, session);
      const inviteCode = matchLine(result.stdout, 'INVITE_CODE:') ?? undefined;
      const status = matchLine(result.stdout, 'STATUS:');
      const headlessLine = matchLine(result.stdout, 'HEADLESS:') ?? matchLine(result.stdout, 'HEADLESS_SET:');
      return {
        role: 'host',
        status: status === '(2/2 connected)' ? 'ready' : 'waiting',
        headless: headlessLine === 'true',
        ...(inviteCode ? { code: inviteCode } : {}),
      };
    }
  }
}

async function getInitialHostEvent(
  options: MutableSupervisorOptions,
  session: SessionState,
  connectionStatus: 'ready' | 'waiting',
): Promise<LoopEvent> {
  const opening = `Hello from ${options.agentLabel}. Please help with this task: ${options.goal} [OVER]`;

  if (connectionStatus === 'ready') {
    return runLoopScript(options, session, 'host', opening);
  }

  for (;;) {
    const waitResult = await runScript(options, 'a2a-wait-message.sh', ['host'], session);
    const output = waitResult.stdout.trim();
    if (output.startsWith('MESSAGE_RECEIVED') && output.includes('[SYSTEM]') && output.toLowerCase().includes('joined')) {
      return runLoopScript(options, session, 'host', opening);
    }
    if (output.startsWith('TIMEOUT_PING_FAILED')) {
      await sleep(5_000);
      continue;
    }
    if (output.startsWith('TIMEOUT_ROOM_ALIVE') || output.startsWith('TIMEOUT_ROOM_CLOSED')) {
      return parseLoopEvent(output);
    }
    if (output.startsWith('MESSAGE_RECEIVED')) {
      return parseLoopEvent(output);
    }
  }
}

async function runLoopScript(
  options: MutableSupervisorOptions,
  session: SessionState,
  role: ConversationRole,
  message?: string,
): Promise<LoopEvent> {
  const args = message ? [role, message] : [role];
  const result = await runScript(options, 'a2a-loop.sh', args, session);
  return parseLoopEvent(result.stdout);
}

async function runRunner(
  options: MutableSupervisorOptions,
  session: SessionState,
  prompt: string,
  incomingMessage: string,
): Promise<string> {
  const promptPath = path.join(session.sessionDir, 'runner-prompt.txt');
  const incomingPath = path.join(session.sessionDir, 'incoming-message.txt');
  const responsePath = path.join(session.sessionDir, 'runner-response.txt');

  fs.writeFileSync(promptPath, prompt, 'utf8');
  fs.writeFileSync(incomingPath, incomingMessage, 'utf8');
  fs.writeFileSync(responsePath, '', 'utf8');

  const env = {
    ...options.env,
    A2A_SUPERVISOR_SESSION_DIR: session.sessionDir,
    A2A_SUPERVISOR_PROMPT_FILE: promptPath,
    A2A_SUPERVISOR_MESSAGE_FILE: incomingPath,
    A2A_SUPERVISOR_RESPONSE_FILE: responsePath,
    A2A_SUPERVISOR_WORKDIR: options.cwd,
    A2A_SUPERVISOR_AGENT_LABEL: options.agentLabel,
    A2A_SUPERVISOR_ROLE: session.role,
    A2A_SUPERVISOR_GOAL: options.goal ?? '',
  };

  const stdout = await runShellCommand(options.runnerCommand, {
    cwd: options.cwd,
    env,
    stdin: prompt,
  });

  const fileReply = fs.readFileSync(responsePath, 'utf8').trim();
  return fileReply || stdout.trim();
}

async function runScript(
  options: MutableSupervisorOptions,
  scriptName: string,
  args: string[],
  session: SessionState,
  env: NodeJS.ProcessEnv = options.env,
): Promise<{ stdout: string; stderr: string }> {
  const scriptPath = path.join(options.scriptDir, scriptName);
  const result = await runProcess('bash', [scriptPath, ...args], {
    cwd: options.cwd,
    env,
  });

  appendTranscript(
    session,
    `$ ${['bash', scriptPath, ...args].join(' ')}\n${result.stdout}${result.stderr ? `\nSTDERR:\n${result.stderr}` : ''}`,
  );

  return result;
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin?: string;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error([`Command failed: ${command} ${args.join(' ')}`, stdout.trim(), stderr.trim()].filter(Boolean).join('\n')));
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

async function runShellCommand(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin: string;
  },
): Promise<string> {
  const result = await runProcess('bash', ['-lc', command], options);
  return result.stdout;
}

function installSignalCleanup(options: MutableSupervisorOptions, session: SessionState): () => void {
  const handler = (signal: NodeJS.Signals) => {
    writeSessionMetadata(session, {
      status: 'interrupted',
      signal,
    });
    runLeaveScript(options, session.role);
    process.exit(1);
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);

  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

function cleanupLocalSession(options: MutableSupervisorOptions, session: SessionState): void {
  runLeaveScript(options, session.role);
}

function runLeaveScript(options: MutableSupervisorOptions, role: ConversationRole): void {
  const leaveScript = path.join(options.scriptDir, 'a2a-leave.sh');
  spawnSync('bash', [leaveScript, role], {
    cwd: options.cwd,
    env: options.env,
    stdio: 'ignore',
  });
}

function matchLine(output: string, prefix: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitReply(reply: string): { body: string; signal: 'OVER' | 'STANDBY' | null } {
  const signalMatch = reply.match(/\[(OVER|STANDBY)\]\s*$/i);
  const signal = (signalMatch?.[1]?.toUpperCase() as 'OVER' | 'STANDBY' | undefined) ?? null;
  const body = signalMatch ? reply.slice(0, signalMatch.index).trimEnd() : reply;
  return { body, signal };
}

function extractSystemBody(output: string): string | null {
  const normalized = output.replace(/\r/g, '');
  const withoutPrefix = normalized.replace(/^MESSAGE_RECEIVED\n/, '').trim();
  if (!withoutPrefix.startsWith('[SYSTEM')) {
    return null;
  }
  return withoutPrefix;
}

function classifySystemMessage(body: string): 'joined' | 'closed' | 'paused' | 'alert' | 'other' {
  const lower = body.toLowerCase();
  if (lower.includes('has joined') || lower.includes('session is live')) {
    return 'joined';
  }
  if (lower.includes('has closed the session') || lower.includes('session ended') || lower.includes('disconnected')) {
    return 'closed';
  }
  if (lower.includes('both agents have signaled standby') || lower.includes('human must intervene')) {
    return 'paused';
  }
  if (lower.includes('[system alert]') || lower.includes('conversation forcibly paused')) {
    return 'alert';
  }
  return 'other';
}
