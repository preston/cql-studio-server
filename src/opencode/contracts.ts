export interface OpenCodeLibraryInput {
  id: string;
  name: string;
  version?: string;
  canonicalUrl?: string;
  cqlContent: string;
  originalContent?: string;
  fhirVersionId?: string;
}

export interface OpenCodeDependencyInput extends OpenCodeLibraryInput {
  system?: string;
}

export interface CreateOpenCodeSessionRequest {
  title?: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  activeLibrary: OpenCodeLibraryInput;
  dependencies?: OpenCodeDependencyInput[];
  /** Injected by the trusted gateway. Never accepted from the browser verbatim. */
  toolBridge?: {
    baseUrl: string;
    capability: string;
  };
}

export interface OpenCodePromptRequest {
  message: string;
  agent?: 'plan' | 'build';
  references?: string[];
  reasoning?: boolean;
}

export interface OpenCodeWorkspaceManifestEntry {
  libraryId: string;
  name: string;
  version?: string;
  canonicalUrl?: string;
  fhirVersionId?: string;
  sourceHash: string;
  draft: boolean;
  writable: boolean;
}

export interface OpenCodeWorkspaceManifest {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  activeLibraryId: string;
  files: Record<string, OpenCodeWorkspaceManifestEntry>;
}

export interface OpenCodeSessionDto {
  id: string;
  openCodeSessionId: string;
  title: string;
  status: 'starting' | 'idle' | 'busy' | 'error';
  activeLibraryId: string;
  activeFile: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  expiresAt: string;
  model: string;
  reasoningEnabled: boolean;
}

export interface OpenCodeFileDiffDto {
  file: string;
  libraryId: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

export interface OpenCodeCommandDto {
  name: string;
  description: string;
  source: 'web' | 'opencode' | 'cql-studio';
  acceptsArguments: boolean;
}

export interface OpenCodeFileReferenceDto {
  path: string;
  name: string;
  writable: boolean;
}

export interface OpenCodeDiagnosticDto {
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface OpenCodeValidationDto {
  valid: boolean;
  diagnostics: OpenCodeDiagnosticDto[];
  checkedAt: string;
}

export interface OpenCodePermissionRequestDto {
  id: string;
  type: string;
  title: string;
  pattern?: string | string[];
  metadata?: Record<string, unknown>;
}

export interface OpenCodeQuestionRequestDto {
  id: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
}

export interface OpenCodeSessionStateDto {
  session: OpenCodeSessionDto;
  messages: unknown[];
  diffs: OpenCodeFileDiffDto[];
  commands: OpenCodeCommandDto[];
  validation: OpenCodeValidationDto | null;
  permissions: OpenCodePermissionRequestDto[];
  questions: OpenCodeQuestionRequestDto[];
  lastEventId: number;
}

export interface OpenCodeEventEnvelope {
  id: number;
  sessionId: string;
  emittedAt: string;
  event: { type: string; properties: Record<string, unknown> };
}

export interface OpenCodeErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export type OpenCodePermissionResponse = 'once' | 'always' | 'reject';
