"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildRunnerPrompt = buildRunnerPrompt;
exports.normalizeSupervisorReply = normalizeSupervisorReply;
exports.parseLoopEvent = parseLoopEvent;
exports.runSupervisor = runSupervisor;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const supervisor_ui_1 = require("./supervisor-ui");
function buildRunnerPrompt(input) {
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
function normalizeSupervisorReply(rawReply) {
    const reply = rawReply.trim();
    if (!reply) {
        throw new Error('Runner returned an empty reply.');
    }
    if (/\[(OVER|STANDBY)\]\s*$/i.test(reply)) {
        return reply;
    }
    return `${reply} [OVER]`;
}
function parseLoopEvent(output) {
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
    const signal = headerMatch?.[2] ?? null;
    const bodyMatches = [...trimmed.matchAll(/^│ ?(.*)$/gm)];
    const bodyLines = bodyMatches
        .map((match, index) => (index === 0 && match[1] === '' ? null : match[1] ?? ''))
        .filter((line) => line !== null);
    const body = bodyLines.join('\n').trim();
    return {
        type: 'message',
        signal,
        speaker,
        body,
    };
}
function stripDeliveredPrefix(output) {
    return output.replace(/^(?:DELIVERED\s*\n)+/, '');
}
function emitUiEvent(options, event) {
    const rendered = (0, supervisor_ui_1.renderUiEvent)(event, options.renderOptions);
    if (event.type === 'notice' && event.level === 'error') {
        options.logger.error(rendered);
        return;
    }
    options.logger.info(rendered);
}
function emitLoopEvent(options, role, event) {
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
function emitSystemEvent(options, role, event) {
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
function emitReply(options, agentLabel, reply) {
    const { signal, body } = splitReply(reply);
    emitUiEvent(options, {
        type: 'message',
        direction: 'outbound',
        speaker: agentLabel,
        signal,
        body,
    });
}
async function runSupervisor(options) {
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
                detail: connect.role === 'join'
                    ? 'Share this listener code with the host and keep this supervisor running.'
                    : 'Share this invite code with the partner to establish the session.',
            });
        }
        if (connect.status === 'waiting') {
            emitUiEvent(resolved, {
                type: 'notice',
                level: 'info',
                label: 'WAITING',
                detail: connect.role === 'host'
                    ? 'Session is ready. Waiting for partner to connect.'
                    : 'Listener is ready. Waiting for the host to redeem the code.',
                layout: 'line',
            });
        }
        else {
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
        let nextEvent;
        if (connect.role === 'host') {
            nextEvent = await getInitialHostEvent(resolved, session, connect.status);
        }
        else {
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
    }
    finally {
        if (shouldCleanupSession) {
            cleanupLocalSession(resolved, session);
        }
        cleanup();
    }
}
function resolveOptions(options) {
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
    const scriptDir = options.scriptDir ?? path_1.default.resolve(process.cwd(), '.agents/skills/a2alinker/scripts');
    const sessionRoot = options.sessionRoot ?? path_1.default.join(os_1.default.tmpdir(), 'a2a-supervisor');
    const cwd = options.cwd ?? process.cwd();
    return {
        ...options,
        headless: options.headless ?? true,
        scriptDir,
        sessionRoot,
        cwd,
        env: { ...process.env, ...options.env },
        logger: options.logger ?? {
            info: (...args) => console.log(...args),
            error: (...args) => console.error(...args),
        },
        renderOptions: (0, supervisor_ui_1.getDefaultRenderOptions)({
            ...(options.plainMode !== undefined ? { plainMode: options.plainMode } : {}),
            ...(options.timestampEnabled !== undefined ? { timestampEnabled: options.timestampEnabled } : {}),
            ...(options.terminalWidth !== undefined ? { width: options.terminalWidth } : {}),
            ...(options.colorEnabled !== undefined ? { colorEnabled: options.colorEnabled } : {}),
        }),
    };
}
function createSessionState(options) {
    fs_1.default.mkdirSync(options.sessionRoot, { recursive: true });
    const sessionId = `a2a_${Date.now()}_${crypto_1.default.randomBytes(4).toString('hex')}`;
    const sessionDir = path_1.default.join(options.sessionRoot, sessionId);
    fs_1.default.mkdirSync(sessionDir, { recursive: false });
    const transcriptPath = path_1.default.join(sessionDir, 'transcript.log');
    const metadataPath = path_1.default.join(sessionDir, 'session.json');
    const state = {
        sessionId,
        sessionDir,
        transcriptPath,
        metadataPath,
        role: options.mode === 'host' ? 'host' : 'join',
        mode: options.mode,
        agentLabel: options.agentLabel,
        goal: options.goal ?? null,
    };
    fs_1.default.writeFileSync(transcriptPath, '', 'utf8');
    fs_1.default.writeFileSync(metadataPath, JSON.stringify({
        sessionId,
        agentLabel: options.agentLabel,
        mode: options.mode,
        goal: options.goal ?? null,
    }, null, 2), 'utf8');
    return state;
}
function writeSessionMetadata(session, patch) {
    const current = JSON.parse(fs_1.default.readFileSync(session.metadataPath, 'utf8'));
    const next = {
        ...current,
        updatedAt: new Date().toISOString(),
        ...patch,
    };
    fs_1.default.writeFileSync(session.metadataPath, JSON.stringify(next, null, 2), 'utf8');
}
function appendTranscript(session, block) {
    fs_1.default.appendFileSync(session.transcriptPath, `${block}\n`, 'utf8');
}
async function connectSession(options, session) {
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
async function getInitialHostEvent(options, session, connectionStatus) {
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
async function runLoopScript(options, session, role, message) {
    const args = message ? [role, message] : [role];
    const result = await runScript(options, 'a2a-loop.sh', args, session);
    return parseLoopEvent(result.stdout);
}
async function runRunner(options, session, prompt, incomingMessage) {
    const promptPath = path_1.default.join(session.sessionDir, 'runner-prompt.txt');
    const incomingPath = path_1.default.join(session.sessionDir, 'incoming-message.txt');
    const responsePath = path_1.default.join(session.sessionDir, 'runner-response.txt');
    fs_1.default.writeFileSync(promptPath, prompt, 'utf8');
    fs_1.default.writeFileSync(incomingPath, incomingMessage, 'utf8');
    fs_1.default.writeFileSync(responsePath, '', 'utf8');
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
    const fileReply = fs_1.default.readFileSync(responsePath, 'utf8').trim();
    return fileReply || stdout.trim();
}
async function runScript(options, scriptName, args, session, env = options.env) {
    const scriptPath = path_1.default.join(options.scriptDir, scriptName);
    const result = await runProcess('bash', [scriptPath, ...args], {
        cwd: options.cwd,
        env,
    });
    appendTranscript(session, `$ ${['bash', scriptPath, ...args].join(' ')}\n${result.stdout}${result.stderr ? `\nSTDERR:\n${result.stderr}` : ''}`);
    return result;
}
async function runProcess(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(command, args, {
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
async function runShellCommand(command, options) {
    const result = await runProcess('bash', ['-lc', command], options);
    return result.stdout;
}
function installSignalCleanup(options, session) {
    const handler = (signal) => {
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
function cleanupLocalSession(options, session) {
    runLeaveScript(options, session.role);
}
function runLeaveScript(options, role) {
    const leaveScript = path_1.default.join(options.scriptDir, 'a2a-leave.sh');
    (0, child_process_1.spawnSync)('bash', [leaveScript, role], {
        cwd: options.cwd,
        env: options.env,
        stdio: 'ignore',
    });
}
function matchLine(output, prefix) {
    for (const line of output.split(/\r?\n/)) {
        if (line.startsWith(prefix)) {
            return line.slice(prefix.length).trim();
        }
    }
    return null;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function splitReply(reply) {
    const signalMatch = reply.match(/\[(OVER|STANDBY)\]\s*$/i);
    const signal = signalMatch?.[1]?.toUpperCase() ?? null;
    const body = signalMatch ? reply.slice(0, signalMatch.index).trimEnd() : reply;
    return { body, signal };
}
function extractSystemBody(output) {
    const normalized = output.replace(/\r/g, '');
    const withoutPrefix = normalized.replace(/^MESSAGE_RECEIVED\n/, '').trim();
    if (!withoutPrefix.startsWith('[SYSTEM')) {
        return null;
    }
    return withoutPrefix;
}
function classifySystemMessage(body) {
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
