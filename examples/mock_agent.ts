type MockAction = 'create' | 'join';

interface RegisterResponse {
  token: string;
}

interface CreateResponse {
  inviteCode: string;
  roomName: string;
}

interface JoinResponse {
  roomName: string;
  role: string;
  headless: boolean;
  rules: string;
  status: string;
}

interface ParsedCliArgs {
  action: MockAction;
  inviteCode?: string;
  baseUrl: string;
}

interface RunMockAgentOptions {
  name: string;
  action: MockAction;
  inviteCode?: string;
  baseUrl: string;
  scriptPhrases: string[];
}

function usage(exampleName: string): string {
  return [
    `Usage: npx ts-node ${exampleName} create [base_url]`,
    `   or: npx ts-node ${exampleName} join <invite_code> [base_url]`,
    '',
    'Examples:',
    `  npx ts-node ${exampleName} create`,
    `  npx ts-node ${exampleName} join invite_abc123 http://127.0.0.1:3000`,
    '',
    'Legacy compatibility:',
    `  npx ts-node ${exampleName} ignored_token create [base_url]`,
    `  npx ts-node ${exampleName} ignored_token join <invite_code> [base_url]`,
  ].join('\n');
}

function parseCliArgs(argv: string[], exampleName: string): ParsedCliArgs {
  const defaultBaseUrl = process.env.A2A_BASE_URL ?? 'http://127.0.0.1:3000';
  const [first, second, third, fourth] = argv;

  if (first === 'create') {
    return {
      action: 'create',
      baseUrl: second ?? defaultBaseUrl,
    };
  }

  if (first === 'join') {
    if (!second) {
      throw new Error(usage(exampleName));
    }
    return {
      action: 'join',
      inviteCode: second,
      baseUrl: third ?? defaultBaseUrl,
    };
  }

  if ((second === 'create' || second === 'join') && first) {
    console.warn(`[example] Ignoring legacy token argument "${first}". The HTTP examples self-register now.`);
    if (second === 'create') {
      return {
        action: 'create',
        baseUrl: third ?? defaultBaseUrl,
      };
    }
    if (!third) {
      throw new Error(usage(exampleName));
    }
    return {
      action: 'join',
      inviteCode: third,
      baseUrl: fourth ?? defaultBaseUrl,
    };
  }

  throw new Error(usage(exampleName));
}

async function requestText(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<string> {
  const response = await fetch(new URL(path, baseUrl), init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed (${response.status}): ${body}`);
  }
  return body;
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const body = await requestText(baseUrl, path, init);
  return JSON.parse(body) as T;
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSystemMessage(message: string): boolean {
  return message.includes('[SYSTEM]');
}

function isTerminalMessage(message: string): boolean {
  return message.includes('Session ended')
    || message.includes('You are disconnected')
    || message.includes('Session expired')
    || message.includes('Broker is draining')
    || message.includes('Conversation forcibly paused');
}

function isPartnerTurn(message: string): boolean {
  return message.startsWith('MESSAGE_RECEIVED') && !isSystemMessage(message);
}

async function register(baseUrl: string): Promise<string> {
  const result = await requestJson<RegisterResponse>(baseUrl, '/register', {
    method: 'POST',
  });
  return result.token;
}

async function createRoom(baseUrl: string, token: string): Promise<CreateResponse> {
  return requestJson<CreateResponse>(baseUrl, '/create', {
    method: 'POST',
    headers: authHeaders(token),
  });
}

async function joinRoom(baseUrl: string, token: string, inviteCode: string): Promise<JoinResponse> {
  return requestJson<JoinResponse>(baseUrl, `/join/${encodeURIComponent(inviteCode)}`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

async function sendMessage(baseUrl: string, token: string, message: string): Promise<void> {
  const response = await requestText(baseUrl, '/send', {
    method: 'POST',
    headers: authHeaders(token, {
      'Content-Type': 'text/plain',
    }),
    body: message,
  });
  if (response !== 'DELIVERED') {
    throw new Error(`Unexpected send response: ${response}`);
  }
}

async function waitForMessage(baseUrl: string, token: string): Promise<string> {
  return requestText(baseUrl, '/wait', {
    method: 'GET',
    headers: authHeaders(token),
  });
}

async function leaveRoom(baseUrl: string, token: string): Promise<void> {
  await requestJson<{ ok: boolean }>(baseUrl, '/leave', {
    method: 'POST',
    headers: authHeaders(token),
  });
}

function logReceivedMessage(name: string, message: string): void {
  console.log(`\n[${name} Simulator] Received from broker:`);
  console.log(message.trimEnd());
}

export async function runMockAgentCli(config: {
  argv: string[];
  exampleName: string;
  name: string;
  scriptPhrases: string[];
}): Promise<void> {
  const parsed = parseCliArgs(config.argv, config.exampleName);
  const options: RunMockAgentOptions = {
    name: config.name,
    action: parsed.action,
    baseUrl: parsed.baseUrl,
    scriptPhrases: config.scriptPhrases,
    ...(parsed.inviteCode ? { inviteCode: parsed.inviteCode } : {}),
  };
  await runMockAgent(options);
}

export async function runMockAgent({
  name,
  action,
  inviteCode,
  baseUrl,
  scriptPhrases,
}: RunMockAgentOptions): Promise<void> {
  console.log(`[${name} Simulator] Registering with HTTP broker at ${baseUrl}...`);
  const token = await register(baseUrl);
  let phraseIndex = 0;
  let closed = false;

  const closeSession = async (reason: string): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await leaveRoom(baseUrl, token);
      console.log(`[${name} Simulator] Closed session (${reason}).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[${name} Simulator] Cleanup warning (${reason}): ${message}`);
    }
  };

  process.once('SIGINT', () => {
    void closeSession('SIGINT').finally(() => {
      process.exit(130);
    });
  });

  if (action === 'create') {
    const created = await createRoom(baseUrl, token);
    console.log(`[${name} Simulator] Created host room ${created.roomName}.`);
    console.log(`[${name} Simulator] Share this invite code with the other agent: ${created.inviteCode}`);
    console.log(`[${name} Simulator] Waiting for the partner to join before sending the opening message...`);
  } else {
    if (!inviteCode) {
      throw new Error('join action requires an invite code');
    }
    const joined = await joinRoom(baseUrl, token, inviteCode);
    console.log(`[${name} Simulator] Joined room ${joined.roomName} as ${joined.role}.`);
    console.log(`[${name} Simulator] Broker status: ${joined.status}`);
    console.log(joined.rules);
  }

  while (true) {
    const message = await waitForMessage(baseUrl, token);
    logReceivedMessage(name, message);

    if (message.startsWith('TIMEOUT:')) {
      continue;
    }

    if (isTerminalMessage(message)) {
      await closeSession('terminal event');
      break;
    }

    const shouldOpenConversation = action === 'create'
      && phraseIndex === 0
      && isSystemMessage(message)
      && message.includes('Session is live!');

    const shouldReplyToPartner = phraseIndex < scriptPhrases.length
      && isPartnerTurn(message)
      && !message.includes('[STANDBY]');

    if (!shouldOpenConversation && !shouldReplyToPartner) {
      if (isPartnerTurn(message) && message.includes('[STANDBY]')) {
        console.log(`[${name} Simulator] Partner entered STANDBY. Ending the demo session.`);
        await closeSession('partner standby');
        break;
      }
      continue;
    }

    if (phraseIndex >= scriptPhrases.length) {
      console.log(`[${name} Simulator] Scripted phrases are exhausted. Ending the demo session.`);
      await closeSession('script complete');
      break;
    }

    const nextPhrase = scriptPhrases[phraseIndex];
    if (!nextPhrase) {
      console.log(`[${name} Simulator] Scripted phrases are exhausted. Ending the demo session.`);
      await closeSession('script complete');
      break;
    }
    phraseIndex += 1;

    console.log(`\n[${name} Simulator] Sending: "${nextPhrase}"`);
    await delay(1200);
    await sendMessage(baseUrl, token, nextPhrase);

    if (nextPhrase.includes('[STANDBY]')) {
      console.log(`[${name} Simulator] Sent STANDBY. Ending the demo session.`);
      await closeSession('sent standby');
      break;
    }
  }
}
