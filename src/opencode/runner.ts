import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { CreateOpenCodeSessionRequest, OpenCodePermissionResponse, OpenCodePromptRequest } from './contracts.js';
import { normalizeOpenCodeError, OpenCodeError } from './errors.js';
import { openCodeLogger } from './logger.js';
import { OpenCodeRuntime } from './runtime.js';

const app = express();
const runtime = new OpenCodeRuntime();
const port = Number.parseInt(process.env.OPENCODE_RUNNER_PORT || '4097', 10);
const token = process.env.OPENCODE_RUNNER_TOKEN || 'cql-studio-opencode-development-only';
const nodeEnv = process.env.OPENCODE_RUNNER_NODE_ENV || process.env.NODE_ENV || 'development';
if (nodeEnv !== 'development' && (token === 'cql-studio-opencode-development-only' || Buffer.byteLength(token) < 32)) {
  throw new Error('OPENCODE_RUNNER_TOKEN must be a non-default secret of at least 32 bytes in production');
}

function validToken(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!validToken(req.header('x-opencode-runner-token'))) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Unauthorized', retryable: false });
    return;
  }
  next();
});

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res).catch(next);
  };
}

app.get('/health', (_req, res) => res.json(runtime.health()));
app.get('/sessions', (_req, res) => res.json(runtime.list()));

app.post('/sessions', asyncHandler(async (req, res) => {
  const input = req.body as CreateOpenCodeSessionRequest;
  if (!input?.activeLibrary?.id || !input.activeLibrary.cqlContent || !input.ollamaBaseUrl || !input.ollamaModel) {
    throw new OpenCodeError('INVALID_SESSION', 'activeLibrary, ollamaBaseUrl, and ollamaModel are required', 400, false);
  }
  res.status(201).json(await runtime.create(input));
}));

app.get('/sessions/:id', (req, res) => res.json(runtime.get(req.params.id).dto));
app.get('/sessions/:id/state', asyncHandler(async (req, res) => {
  res.json(await runtime.state(req.params.id));
}));
app.get('/sessions/:id/messages', asyncHandler(async (req, res) => {
  res.json(await runtime.messages(req.params.id));
}));
app.get('/sessions/:id/diff', asyncHandler(async (req, res) => {
  res.json(await runtime.diff(req.params.id));
}));
app.get('/sessions/:id/commands', asyncHandler(async (req, res) => {
  res.json(await runtime.commands(req.params.id));
}));
app.get('/sessions/:id/files', asyncHandler(async (req, res) => {
  res.json(await runtime.files(req.params.id, String(req.query.q ?? ''), Number(req.query.limit) || 30));
}));
app.post('/sessions/:id/commands/:command', asyncHandler(async (req, res) => {
  await runtime.executeCommand(
    req.params.id,
    req.params.command,
    typeof req.body?.arguments === 'string' ? req.body.arguments : '',
    Boolean(req.body?.reasoning)
  );
  res.status(202).json({ accepted: true });
}));
app.post('/sessions/:id/validate', asyncHandler(async (req, res) => {
  res.json(await runtime.validate(req.params.id));
}));

app.post('/sessions/:id/prompt', asyncHandler(async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) {
    throw new OpenCodeError('INVALID_PROMPT', 'message is required', 400, false);
  }
  await runtime.prompt(req.params.id, {
    message,
    agent: req.body?.agent === 'plan' ? 'plan' : 'build',
    references: Array.isArray(req.body?.references) ? req.body.references.filter((item: unknown) => typeof item === 'string') : [],
    reasoning: Boolean(req.body?.reasoning),
  } satisfies OpenCodePromptRequest);
  res.status(202).json({ accepted: true });
}));

app.post('/sessions/:id/abort', asyncHandler(async (req, res) => {
  await runtime.abort(req.params.id);
  res.json({ aborted: true });
}));

app.post('/sessions/:id/permissions/:permissionId', asyncHandler(async (req, res) => {
  const response = req.body?.response as OpenCodePermissionResponse;
  if (!['once', 'always', 'reject'].includes(response)) {
    throw new OpenCodeError('INVALID_PERMISSION_RESPONSE', 'response must be once, always, or reject', 400, false);
  }
  await runtime.permission(req.params.id, req.params.permissionId, response);
  res.json({ accepted: true });
}));

app.post('/sessions/:id/questions/:requestId', asyncHandler(async (req, res) => {
  const answers = req.body?.answers;
  if (!Array.isArray(answers) || !answers.every(answer => Array.isArray(answer) && answer.every(item => typeof item === 'string'))) {
    throw new OpenCodeError('INVALID_QUESTION_RESPONSE', 'answers must be an array of string arrays', 400, false);
  }
  await runtime.answerQuestion(req.params.id, req.params.requestId, answers);
  res.json({ accepted: true });
}));

app.delete('/sessions/:id/questions/:requestId', asyncHandler(async (req, res) => {
  await runtime.rejectQuestion(req.params.id, req.params.requestId);
  res.status(204).send();
}));

app.get('/sessions/:id/events', (req, res, next) => {
  try {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const lastEventId = Number(req.get('last-event-id') ?? req.query.after ?? 0) || 0;
    const unsubscribe = runtime.subscribe(req.params.id, envelope => {
      res.write(`id: ${envelope.id}\n`);
      res.write(`data: ${JSON.stringify(envelope)}\n\n`);
    }, lastEventId);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/sessions/:id', asyncHandler(async (req, res) => {
  await runtime.remove(req.params.id);
  res.status(204).send();
}));
app.delete('/sessions', asyncHandler(async (_req, res) => {
  await runtime.removeAll();
  res.status(204).send();
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const normalized = normalizeOpenCodeError(error);
  openCodeLogger.error({ operation: 'runner.request', code: normalized.code, status: normalized.status, err: normalized }, normalized.message);
  res.status(normalized.status).json(normalized.toBody());
});

await runtime.initialize();
app.listen(port, '0.0.0.0', () => {
  openCodeLogger.info({ operation: 'runner.listen', port }, 'CQL Studio OpenCode runner listening');
});
