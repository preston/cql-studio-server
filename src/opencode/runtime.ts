import { pathToFileURL } from 'node:url';
import {
  createOpencode,
  createOpencodeClient,
  type Event,
  type FilePartInput,
  type OpencodeClient,
} from '@opencode-ai/sdk/v2';
import type {
  CreateOpenCodeSessionRequest,
  OpenCodeCommandDto,
  OpenCodeEventEnvelope,
  OpenCodeFileDiffDto,
  OpenCodeFileReferenceDto,
  OpenCodePermissionRequestDto,
  OpenCodeQuestionRequestDto,
  OpenCodePermissionResponse,
  OpenCodePromptRequest,
  OpenCodeSessionDto,
  OpenCodeSessionStateDto,
  OpenCodeValidationDto,
} from './contracts.js';
import { OpenCodeError } from './errors.js';
import { openCodeLogger } from './logger.js';
import { OpenCodeWorkspaceManager, type MaterializedWorkspace } from './workspace.js';

type RuntimeEvent = Event | { type: string; properties: Record<string, unknown> };
type EventListener = (event: OpenCodeEventEnvelope) => void;

interface RuntimeSession {
  dto: OpenCodeSessionDto;
  workspace: MaterializedWorkspace;
  client: OpencodeClient;
  listeners: Set<EventListener>;
  history: OpenCodeEventEnvelope[];
  nextEventId: number;
  eventAbort: AbortController;
  validation: OpenCodeValidationDto | null;
  toolBridge?: { baseUrl: string; capability: string };
  stallTimer?: NodeJS.Timeout;
}

const CQL_COMMANDS = new Set(['validate', 'review', 'explain', 'dependencies', 'library', 'valueset']);

export class OpenCodeRuntime {
  private readonly workspaces = new OpenCodeWorkspaceManager();
  private readonly sessions = new Map<string, RuntimeSession>();
  private server: Awaited<ReturnType<typeof createOpencode>> | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly idleMs = Number.parseInt(process.env.OPENCODE_SESSION_IDLE_MS || '3600000', 10);
  private readonly cleanupMs = Number.parseInt(process.env.OPENCODE_CLEANUP_INTERVAL_MS || '60000', 10);
  private readonly providerStallMs = Number.parseInt(process.env.OPENCODE_PROVIDER_STALL_MS || '300000', 10);

  async initialize(): Promise<void> {
    await this.workspaces.initialize();
    this.server = await createOpencode({
      hostname: '127.0.0.1',
      port: Number.parseInt(process.env.OPENCODE_INTERNAL_PORT || '4096', 10),
      timeout: 20_000,
      config: { autoupdate: false, share: 'disabled', logLevel: 'WARN' },
    });
    this.cleanupTimer = setInterval(() => void this.removeExpired(), this.cleanupMs);
    this.cleanupTimer.unref();
  }

  health(): { healthy: boolean; sessions: number; serverUrl?: string } {
    return { healthy: !!this.server, sessions: this.sessions.size, serverUrl: this.server?.server.url };
  }

  list(): OpenCodeSessionDto[] {
    return [...this.sessions.values()].map(session => session.dto).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(input: CreateOpenCodeSessionRequest): Promise<OpenCodeSessionDto> {
    if (!this.server) throw new OpenCodeError('RUNNER_UNAVAILABLE', 'OpenCode runtime is not initialized', 503, true);
    const workspace = await this.workspaces.create(input);
    try {
      const client = createOpencodeClient({
        baseUrl: this.server.server.url,
        directory: workspace.directory,
        throwOnError: true,
      });
      const created = await client.session.create({
        title: input.title || input.activeLibrary.name,
        model: { id: input.ollamaModel, providerID: 'ollama', variant: 'fast' },
      });
      const openCodeSession = created.data;
      if (!openCodeSession) throw new Error('OpenCode did not return a session');
      const now = new Date();
      const dto: OpenCodeSessionDto = {
        id: workspace.id,
        openCodeSessionId: openCodeSession.id,
        title: input.title || input.activeLibrary.name,
        status: 'idle',
        activeLibraryId: input.activeLibrary.id,
        activeFile: workspace.activeFile,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.idleMs).toISOString(),
        model: input.ollamaModel,
        reasoningEnabled: false,
      };
      const runtime: RuntimeSession = {
        dto,
        workspace,
        client,
        listeners: new Set(),
        history: [],
        nextEventId: 1,
        eventAbort: new AbortController(),
        validation: null,
        toolBridge: input.toolBridge,
      };
      this.sessions.set(dto.id, runtime);
      void this.pumpEvents(runtime);
      openCodeLogger.info({ operation: 'session.create', sessionId: dto.id, activeLibraryId: dto.activeLibraryId }, 'OpenCode session created');
      return dto;
    } catch (error) {
      await this.workspaces.remove(workspace);
      throw error;
    }
  }

  get(id: string): RuntimeSession {
    const session = this.sessions.get(id);
    if (!session) throw new OpenCodeError('SESSION_NOT_FOUND', 'OpenCode session not found', 404, false);
    if (session.dto.status !== 'busy' && Date.parse(session.dto.expiresAt) <= Date.now()) {
      void this.remove(id);
      throw new OpenCodeError('SESSION_EXPIRED', 'OpenCode session expired after 60 minutes of inactivity', 410, false);
    }
    return session;
  }

  async prompt(id: string, input: OpenCodePromptRequest): Promise<void> {
    const session = this.get(id);
    this.touch(session);
    session.dto.status = 'busy';
    session.dto.reasoningEnabled = Boolean(input.reasoning);
    this.armStallTimer(session);
    const parts: Array<{ type: 'text'; text: string } | FilePartInput> = [{ type: 'text', text: input.message }];
    for (const reference of [...new Set(input.references ?? [])].slice(0, 20)) {
      const absolute = this.workspaces.resolveReference(session.workspace, reference);
      const marker = `@${reference}`;
      const start = Math.max(0, input.message.indexOf(marker));
      parts.push({
        type: 'file',
        mime: 'text/plain',
        filename: reference,
        url: pathToFileURL(absolute).href,
        source: { type: 'file', path: absolute, text: { value: marker, start, end: start + marker.length } },
      });
    }
    try {
      await session.client.session.promptAsync({
        sessionID: session.dto.openCodeSessionId,
        agent: input.agent === 'plan' ? 'plan' : 'build',
        model: { providerID: 'ollama', modelID: session.dto.model },
        variant: input.reasoning ? 'thinking' : 'fast',
        parts,
      });
    } catch (error) {
      session.dto.status = 'error';
      if (session.stallTimer) clearTimeout(session.stallTimer);
      throw error;
    }
  }

  async executeCommand(id: string, command: string, args = '', reasoning = false): Promise<void> {
    const session = this.get(id);
    const normalized = command.replace(/^\//, '').trim();
    if (!/^[a-z][a-z0-9_-]*$/i.test(normalized)) throw new OpenCodeError('INVALID_COMMAND', 'Command name is invalid', 400);
    this.touch(session);
    session.dto.status = 'busy';
    session.dto.reasoningEnabled = reasoning;
    this.armStallTimer(session);
    try {
      if (normalized === 'compact') {
        await session.client.session.summarize({
          sessionID: session.dto.openCodeSessionId,
          providerID: 'ollama',
          modelID: session.dto.model,
          auto: false,
        });
        return;
      }
      const commands = await this.commands(id);
      if (!commands.some(item => item.name === normalized && item.source !== 'web')) {
        throw new OpenCodeError('COMMAND_NOT_FOUND', `OpenCode command was not found: /${normalized}`, 404);
      }
      await session.client.session.command({
        sessionID: session.dto.openCodeSessionId,
        command: normalized,
        arguments: args,
        agent: 'build',
        model: `ollama/${session.dto.model}`,
        variant: reasoning ? 'thinking' : 'fast',
      });
    } catch (error) {
      session.dto.status = 'error';
      if (session.stallTimer) clearTimeout(session.stallTimer);
      throw error;
    }
  }

  async commands(id: string): Promise<OpenCodeCommandDto[]> {
    const session = this.get(id);
    const result = await session.client.command.list();
    const commands = result.data ?? [];
    return commands
      .filter(command => !command.source || command.source === 'command')
      .filter(command => !['connect', 'models', 'editor', 'init', 'export', 'themes', 'share', 'unshare', 'exit', 'undo', 'redo'].includes(command.name))
      .map(command => ({
        name: command.name,
        description: command.description || `Run /${command.name}`,
        source: CQL_COMMANDS.has(command.name) ? 'cql-studio' as const : 'opencode' as const,
        acceptsArguments: command.template.includes('$ARGUMENTS'),
      }));
  }

  async files(id: string, query = '', limit = 30): Promise<OpenCodeFileReferenceDto[]> {
    const session = this.get(id);
    const allowed = this.workspaces.references(session.workspace, '', 50);
    const allowedByPath = new Map(allowed.map(file => [file.path, file]));
    const result = await session.client.find.files({ query, type: 'file', limit: Math.min(Math.max(limit, 1), 50) });
    const sdkPaths = (result.data ?? []).map(item => typeof item === 'string' ? item : String(item));
    return sdkPaths.map(file => file.replace(/^\.\//, '')).filter(file => allowedByPath.has(file))
      .map(file => allowedByPath.get(file)!)
      .slice(0, limit);
  }

  async messages(id: string): Promise<unknown[]> {
    const session = this.get(id);
    const result = await session.client.session.messages({ sessionID: session.dto.openCodeSessionId });
    return result.data ?? [];
  }

  async diff(id: string): Promise<OpenCodeFileDiffDto[]> {
    return this.workspaces.diff(this.get(id).workspace);
  }

  async state(id: string): Promise<OpenCodeSessionStateDto> {
    const session = this.get(id);
    const [messages, diffs, commands, permissions, questions] = await Promise.all([
      this.messages(id),
      this.diff(id),
      this.commands(id),
      this.permissions(id),
      this.questions(id),
    ]);
    return {
      session: session.dto,
      messages,
      diffs,
      commands,
      validation: session.validation,
      permissions,
      questions,
      lastEventId: session.nextEventId - 1,
    };
  }

  async permissions(id: string): Promise<OpenCodePermissionRequestDto[]> {
    const session = this.get(id);
    const result = await session.client.permission.list();
    return (result.data ?? [])
      .filter(request => request.sessionID === session.dto.openCodeSessionId)
      .map(request => ({
        id: request.id,
        type: request.permission,
        title: `OpenCode requests permission to ${request.permission}`,
        pattern: request.patterns,
        metadata: request.metadata,
      }));
  }

  async questions(id: string): Promise<OpenCodeQuestionRequestDto[]> {
    const session = this.get(id);
    const result = await session.client.question.list();
    return (result.data ?? [])
      .filter(request => request.sessionID === session.dto.openCodeSessionId)
      .map(request => ({ id: request.id, questions: request.questions }));
  }

  async validate(id: string): Promise<OpenCodeValidationDto> {
    const session = this.get(id);
    if (!session.toolBridge) throw new OpenCodeError('VALIDATION_UNAVAILABLE', 'CQL validation bridge is unavailable', 503, true);
    const workspace = await this.workspaces.validationPayload(session.workspace);
    const response = await fetch(`${session.toolBridge.baseUrl.replace(/\/+$/, '')}/execute`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.toolBridge.capability}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cql_validate', arguments: { __workspace: workspace } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new OpenCodeError('VALIDATION_UNAVAILABLE', `CQL validation failed (${response.status})`, 503, true);
    session.validation = await response.json() as OpenCodeValidationDto;
    this.emit(session, { type: 'cql.validation.updated', properties: session.validation as unknown as Record<string, unknown> });
    return session.validation;
  }

  async abort(id: string): Promise<void> {
    const session = this.get(id);
    await session.client.session.abort({ sessionID: session.dto.openCodeSessionId });
    session.dto.status = 'idle';
    this.touch(session);
  }

  async permission(id: string, permissionId: string, response: OpenCodePermissionResponse): Promise<void> {
    const session = this.get(id);
    await session.client.permission.reply({ requestID: permissionId, reply: response });
    this.touch(session);
  }

  async answerQuestion(id: string, requestId: string, answers: string[][]): Promise<void> {
    const session = this.get(id);
    await session.client.question.reply({ requestID: requestId, answers });
    this.touch(session);
  }

  async rejectQuestion(id: string, requestId: string): Promise<void> {
    const session = this.get(id);
    await session.client.question.reject({ requestID: requestId });
    this.touch(session);
  }

  subscribe(id: string, listener: EventListener, afterId = 0): () => void {
    const session = this.get(id);
    session.history.filter(envelope => envelope.id > afterId).forEach(listener);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.eventAbort.abort();
    if (session.stallTimer) clearTimeout(session.stallTimer);
    await session.client.session.delete({ sessionID: session.dto.openCodeSessionId }).catch(() => undefined);
    await this.workspaces.remove(session.workspace);
    this.sessions.delete(id);
    openCodeLogger.info({ operation: 'session.remove', sessionId: id }, 'OpenCode session removed');
  }

  async removeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(id => this.remove(id)));
  }

  private touch(session: RuntimeSession): void {
    const now = new Date();
    session.dto.updatedAt = now.toISOString();
    session.dto.lastActivityAt = now.toISOString();
    session.dto.expiresAt = new Date(now.getTime() + this.idleMs).toISOString();
  }

  private emit(session: RuntimeSession, event: RuntimeEvent): void {
    const envelope: OpenCodeEventEnvelope = {
      id: session.nextEventId++,
      sessionId: session.dto.id,
      emittedAt: new Date().toISOString(),
      event: event as OpenCodeEventEnvelope['event'],
    };
    session.history.push(envelope);
    if (session.history.length > 1_000) session.history.shift();
    session.listeners.forEach(listener => listener(envelope));
  }

  private async pumpEvents(session: RuntimeSession): Promise<void> {
    try {
      const subscription = await session.client.event.subscribe({}, { signal: session.eventAbort.signal });
      for await (const event of subscription.stream) {
        const typed = event as Event;
        const properties = typed.properties as Record<string, any>;
        const eventSessionId = properties['sessionID'] ?? properties['info']?.sessionID ?? properties['part']?.sessionID;
        if (eventSessionId && eventSessionId !== session.dto.openCodeSessionId) continue;
        if (typed.type === 'session.status') {
          session.dto.status = properties['status']?.type === 'busy' ? 'busy' : 'idle';
        } else if (typed.type === 'session.idle') {
          session.dto.status = 'idle';
          if (session.stallTimer) clearTimeout(session.stallTimer);
          this.touch(session);
        } else if (typed.type === 'session.error') {
          session.dto.status = 'error';
        }
        if (session.dto.status === 'busy') this.armStallTimer(session);
        this.emit(session, typed);
        if (typed.type === 'session.idle') {
          void this.validate(session.dto.id).catch(error => {
            this.emit(session, { type: 'cql.validation.error', properties: { message: error instanceof Error ? error.message : String(error) } });
          });
        }
      }
    } catch (error) {
      if (session.eventAbort.signal.aborted) return;
      session.dto.status = 'error';
      this.emit(session, {
        type: 'runner.error',
        properties: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async removeExpired(): Promise<void> {
    const now = Date.now();
    const expired = [...this.sessions.values()]
      .filter(session => session.dto.status !== 'busy' && Date.parse(session.dto.expiresAt) <= now)
      .map(session => session.dto.id);
    await Promise.all(expired.map(id => this.remove(id)));
  }

  private armStallTimer(session: RuntimeSession): void {
    if (session.stallTimer) clearTimeout(session.stallTimer);
    session.stallTimer = setTimeout(() => {
      if (session.dto.status !== 'busy') return;
      void session.client.session.abort({ sessionID: session.dto.openCodeSessionId }).catch(() => undefined);
      session.dto.status = 'error';
      this.emit(session, {
        type: 'runner.error',
        properties: {
          code: 'OLLAMA_STALLED',
          message: `Ollama produced no progress for ${Math.round(this.providerStallMs / 1000)} seconds. The request was stopped and can be retried.`,
          retryable: true,
        },
      });
    }, this.providerStallMs);
    session.stallTimer.unref();
  }
}
