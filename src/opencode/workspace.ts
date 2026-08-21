import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import type {
  CreateOpenCodeSessionRequest,
  OpenCodeFileDiffDto,
  OpenCodeWorkspaceManifest,
} from './contracts.js';

export interface MaterializedWorkspace {
  id: string;
  directory: string;
  activeFile: string;
  manifest: OpenCodeWorkspaceManifest;
  baselineByFile: Map<string, string>;
}

function safeSegment(value: string, fallback: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 100);
  return normalized || fallback;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function countChangedLines(before: string, after: string): { additions: number; deletions: number } {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    deletions: Math.max(0, beforeLines.length - prefix - suffix),
    additions: Math.max(0, afterLines.length - prefix - suffix),
  };
}

function normalizeOllamaBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (
    process.env.OPENCODE_RUNNER_REWRITE_LOCALHOST !== 'false' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  ) {
    url.hostname = 'host.docker.internal';
  }
  const withoutSlash = url.toString().replace(/\/+$/, '');
  return withoutSlash.endsWith('/v1') ? withoutSlash : `${withoutSlash}/v1`;
}

export class OpenCodeWorkspaceManager {
  private readonly root: string;

  constructor(root = process.env.OPENCODE_RUNNER_WORKSPACE_ROOT || '/workspaces') {
    this.root = path.resolve(root);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // Runtime sessions are intentionally ephemeral. Anything left at runner startup
    // cannot have a live owning session and is therefore an orphan.
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const orphan = path.join(this.root, entry.name);
      await chmod(path.join(orphan, 'dependencies'), 0o700).catch(() => undefined);
      await rm(orphan, { recursive: true, force: true });
    }
  }

  async create(input: CreateOpenCodeSessionRequest): Promise<MaterializedWorkspace> {
    const id = randomUUID();
    const directory = path.join(this.root, id);
    const librariesDirectory = path.join(directory, 'libraries');
    const dependenciesDirectory = path.join(directory, 'dependencies');
    const metadataDirectory = path.join(directory, '.cql-studio');
    const commandsDirectory = path.join(directory, '.opencode', 'commands');
    await mkdir(librariesDirectory, { recursive: true, mode: 0o700 });
    // Populate first, then remove directory write permission once all dependencies exist.
    await mkdir(dependenciesDirectory, { recursive: true, mode: 0o700 });
    await mkdir(metadataDirectory, { recursive: true, mode: 0o700 });
    await mkdir(commandsDirectory, { recursive: true, mode: 0o700 });

    const usedNames = new Set<string>();
    const uniqueFile = (name: string, fallback: string): string => {
      const base = safeSegment(name, fallback).replace(/\.cql$/i, '');
      let candidate = `${base}.cql`;
      let index = 2;
      while (usedNames.has(candidate.toLowerCase())) {
        candidate = `${base}-${index++}.cql`;
      }
      usedNames.add(candidate.toLowerCase());
      return candidate;
    };

    const activeName = uniqueFile(input.activeLibrary.name, input.activeLibrary.id);
    const activeFile = `libraries/${activeName}`;
    await writeFile(path.join(directory, activeFile), input.activeLibrary.cqlContent, {
      encoding: 'utf8',
      mode: 0o600,
    });

    const manifest: OpenCodeWorkspaceManifest = {
      schemaVersion: 1,
      sessionId: id,
      createdAt: new Date().toISOString(),
      activeLibraryId: input.activeLibrary.id,
      files: {
        [activeFile]: {
          libraryId: input.activeLibrary.id,
          name: input.activeLibrary.name,
          version: input.activeLibrary.version,
          canonicalUrl: input.activeLibrary.canonicalUrl,
          fhirVersionId: input.activeLibrary.fhirVersionId,
          sourceHash: sha256(input.activeLibrary.originalContent ?? input.activeLibrary.cqlContent),
          draft: (input.activeLibrary.originalContent ?? input.activeLibrary.cqlContent) !== input.activeLibrary.cqlContent,
          writable: true,
        },
      },
    };

    for (const dependency of input.dependencies ?? []) {
      if (!dependency.cqlContent.trim() || dependency.id === input.activeLibrary.id) continue;
      const dependencyName = uniqueFile(dependency.name, dependency.id);
      const relativeFile = `dependencies/${dependencyName}`;
      const absoluteFile = path.join(directory, relativeFile);
      await writeFile(absoluteFile, dependency.cqlContent, { encoding: 'utf8', mode: 0o400 });
      manifest.files[relativeFile] = {
        libraryId: dependency.id,
        name: dependency.name,
        version: dependency.version,
        canonicalUrl: dependency.canonicalUrl,
        fhirVersionId: dependency.fhirVersionId,
        sourceHash: sha256(dependency.originalContent ?? dependency.cqlContent),
        draft: false,
        writable: false,
      };
    }
    await chmod(dependenciesDirectory, 0o500);

    const agentInstructions = [
      '# CQL Studio OpenCode workspace',
      '',
      `The active writable CQL library is \`${activeFile}\`.`,
      'Files in `dependencies/` are reference-only and must not be edited.',
      'Only edit files under `libraries/`.',
      'Preserve the CQL library name and version unless the user explicitly asks to change them.',
      'Never invent ValueSet, CodeSystem, or VSAC canonical URLs.',
      'Do not access paths outside this workspace and do not run destructive commands.',
      'CQL Studio will validate and review every file diff before saving it to FHIR.',
      '',
    ].join('\n');
    await writeFile(path.join(directory, 'AGENTS.md'), agentInstructions, { encoding: 'utf8', mode: 0o400 });

    const commands: Record<string, string> = {
      validate: `Validate @${activeFile} with cql_validate. Report errors and warnings with locations. Do not edit unless explicitly asked.`,
      review: `Review @${activeFile} for CQL correctness, clinical intent, dependency usage, terminology accuracy, and maintainability. Use read-only tools as needed.`,
      explain: `Explain the requested CQL in @${activeFile} for a CQL author. Focus on: $ARGUMENTS`,
      dependencies: `Inspect @${activeFile} and the dependency files. Explain every include, missing or conflicting version, and any dependency-related validation problem.`,
      library: `Use cql_library_search and cql_library_read to research this library request without modifying FHIR: $ARGUMENTS`,
      valueset: `Use VSAC and terminology tools to research this ValueSet request. Never guess an identifier or canonical URL: $ARGUMENTS`,
    };
    await Promise.all(Object.entries(commands).map(([name, template]) =>
      writeFile(
        path.join(commandsDirectory, `${name}.md`),
        `---\ndescription: ${name[0].toUpperCase()}${name.slice(1)} CQL workflow\n---\n${template}\n`,
        { encoding: 'utf8', mode: 0o400 }
      )
    ));

    const opencodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      model: `ollama/${input.ollamaModel}`,
      small_model: `ollama/${input.ollamaModel}`,
      instructions: ['AGENTS.md'],
      permission: {
        // OpenCode 1.18.x currently hides native edit/write tools when a granular
        // catch-all deny is present, then applies that deny before a file-specific
        // allow at call time. Filesystem modes are the authoritative boundary:
        // the active file is 0600; dependencies, config, manifest, commands, and
        // instructions are 0400. MCP tools remain read-only.
        edit: 'allow',
        bash: 'deny',
        webfetch: 'deny',
        external_directory: 'deny',
        doom_loop: 'ask',
      },
      provider: {
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Ollama (local)',
          options: { baseURL: normalizeOllamaBaseUrl(input.ollamaBaseUrl) },
          models: {
            [input.ollamaModel]: {
              name: input.ollamaModel,
              options: { reasoningEffort: 'none' },
              variants: {
                fast: { reasoningEffort: 'none' },
                thinking: { reasoningEffort: 'medium' },
              },
            },
          },
        },
      },
      ...(input.toolBridge ? {
        mcp: {
          'cql-studio': {
            type: 'local',
            command: ['node', '/app/dist/opencode/mcp-bridge.js'],
            environment: {
              CQL_STUDIO_MCP_BRIDGE_URL: input.toolBridge.baseUrl,
              CQL_STUDIO_MCP_CAPABILITY: input.toolBridge.capability,
              CQL_STUDIO_MCP_WORKSPACE: directory,
              CQL_STUDIO_MCP_ACTIVE_FILE: activeFile,
            },
            enabled: true,
            timeout: 15_000,
          },
        },
      } : {}),
    };
    await writeFile(path.join(directory, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2), {
      encoding: 'utf8',
      mode: 0o400,
    });
    await writeFile(path.join(metadataDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2), {
      encoding: 'utf8',
      mode: 0o400,
    });

    return {
      id,
      directory,
      activeFile,
      manifest,
      baselineByFile: new Map([[activeFile, input.activeLibrary.cqlContent]]),
    };
  }

  async diff(workspace: MaterializedWorkspace): Promise<OpenCodeFileDiffDto[]> {
    const diffs: OpenCodeFileDiffDto[] = [];
    for (const [file, before] of workspace.baselineByFile) {
      const after = await readFile(path.join(workspace.directory, file), 'utf8');
      if (after === before) continue;
      const counts = countChangedLines(before, after);
      diffs.push({
        file,
        libraryId: workspace.manifest.files[file].libraryId,
        before,
        after,
        ...counts,
      });
    }
    return diffs;
  }

  references(workspace: MaterializedWorkspace, query = '', limit = 30): Array<{ path: string; name: string; writable: boolean }> {
    const normalized = query.trim().toLowerCase().replace(/^@/, '');
    return Object.entries(workspace.manifest.files)
      .filter(([file]) => file.toLowerCase().endsWith('.cql') && (!normalized || file.toLowerCase().includes(normalized)))
      .slice(0, Math.min(Math.max(limit, 1), 50))
      .map(([file, entry]) => ({ path: file, name: path.basename(file), writable: entry.writable }));
  }

  resolveReference(workspace: MaterializedWorkspace, relativeFile: string): string {
    const normalized = relativeFile.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!workspace.manifest.files[normalized] || !normalized.toLowerCase().endsWith('.cql')) {
      throw new Error(`CQL workspace reference is not allowed: ${relativeFile}`);
    }
    const absolute = path.resolve(workspace.directory, normalized);
    if (!absolute.startsWith(`${workspace.directory}${path.sep}`)) {
      throw new Error(`CQL workspace reference escaped the workspace: ${relativeFile}`);
    }
    return absolute;
  }

  async validationPayload(workspace: MaterializedWorkspace, requestedFile?: string): Promise<{
    activeFile: string;
    files: Array<{ path: string; content: string; writable: boolean }>;
  }> {
    const activeFile = requestedFile || workspace.activeFile;
    this.resolveReference(workspace, activeFile);
    const files = await Promise.all(Object.entries(workspace.manifest.files).map(async ([file, entry]) => ({
      path: file,
      content: await readFile(this.resolveReference(workspace, file), 'utf8'),
      writable: entry.writable,
    })));
    return { activeFile, files };
  }

  async remove(workspace: MaterializedWorkspace): Promise<void> {
    const resolved = path.resolve(workspace.directory);
    if (path.dirname(resolved) !== this.root) {
      throw new Error('Refusing to remove a workspace outside the configured root');
    }
    // Dependencies are intentionally locked while a session is active; unlock only for cleanup.
    await chmod(path.join(resolved, 'dependencies'), 0o700).catch(() => undefined);
    await rm(resolved, { recursive: true, force: true });
  }
}
