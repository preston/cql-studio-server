import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OpenCodeWorkspaceManager } from '../src/opencode/workspace.js';

const activeCql = `library Example version '1.0.0'\nusing FHIR version '4.0.1'\ninclude Shared version '1.0.0'\ndefine Answer: 42\n`;

test('materializes a writable draft, read-only dependencies, MCP config, and a review diff', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cql-studio-opencode-'));
  const manager = new OpenCodeWorkspaceManager(root);
  await manager.initialize();
  const workspace = await manager.create({
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'qwen3-coder:latest',
    activeLibrary: {
      id: '../Example',
      name: '../Example With Spaces',
      version: '1.0.0',
      cqlContent: activeCql,
      originalContent: activeCql.replace('42', '41'),
    },
    dependencies: [{
      id: 'Shared',
      name: 'Shared',
      version: '1.0.0',
      cqlContent: `library Shared version '1.0.0'\ndefine SharedValue: true\n`,
    }],
    toolBridge: {
      baseUrl: 'http://host.docker.internal:3003/api/opencode/tool-bridge',
      capability: 'opaque-test-capability',
    },
  });

  try {
    assert.equal(workspace.activeFile, 'libraries/Example-With-Spaces.cql');
    assert.equal(await readFile(path.join(workspace.directory, workspace.activeFile), 'utf8'), activeCql);
    assert.equal((await stat(path.join(workspace.directory, workspace.activeFile))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(workspace.directory, 'dependencies/Shared.cql'))).mode & 0o777, 0o400);
    await assert.rejects(
      writeFile(path.join(workspace.directory, 'dependencies/Shared.cql'), 'changed', 'utf8')
    );

    const manifest = JSON.parse(await readFile(path.join(workspace.directory, '.cql-studio/manifest.json'), 'utf8'));
    assert.equal(manifest.activeLibraryId, '../Example');
    assert.equal(manifest.files[workspace.activeFile].draft, true);
    assert.equal(manifest.files['dependencies/Shared.cql'].writable, false);

    const config = JSON.parse(await readFile(path.join(workspace.directory, 'opencode.json'), 'utf8'));
    assert.equal(config.model, 'ollama/qwen3-coder:latest');
    assert.equal(config.provider.ollama.npm, '@ai-sdk/openai-compatible');
    assert.equal(config.provider.ollama.name, 'Ollama (local)');
    assert.equal(config.provider.ollama.options.baseURL, 'http://host.docker.internal:11434/v1');
    assert.equal(config.provider.ollama.models['qwen3-coder:latest'].options.reasoningEffort, 'none');
    assert.equal('tool_call' in config.provider.ollama.models['qwen3-coder:latest'], false);
    assert.deepEqual(config.permission, {
      edit: 'allow',
      bash: 'deny',
      webfetch: 'deny',
      external_directory: 'deny',
      doom_loop: 'ask',
    });
    assert.equal(config.mcp['cql-studio'].environment.CQL_STUDIO_MCP_CAPABILITY, 'opaque-test-capability');
    assert.equal(config.mcp['cql-studio'].environment.CQL_STUDIO_MCP_ACTIVE_FILE, workspace.activeFile);
    assert.equal(config.provider.ollama.models['qwen3-coder:latest'].variants.fast.reasoningEffort, 'none');
    assert.equal(config.provider.ollama.models['qwen3-coder:latest'].variants.thinking.reasoningEffort, 'medium');
    assert.match(await readFile(path.join(workspace.directory, '.opencode/commands/validate.md'), 'utf8'), /cql_validate/);
    for (const protectedFile of [
      'AGENTS.md',
      'opencode.json',
      '.cql-studio/manifest.json',
      '.opencode/commands/validate.md',
    ]) {
      assert.equal((await stat(path.join(workspace.directory, protectedFile))).mode & 0o777, 0o400);
    }
    assert.deepEqual(manager.references(workspace, 'Shared'), [{
      path: 'dependencies/Shared.cql',
      name: 'Shared.cql',
      writable: false,
    }]);
    assert.throws(() => manager.resolveReference(workspace, '../outside.cql'), /not allowed/);

    const edited = activeCql.replace('42', '43');
    await writeFile(path.join(workspace.directory, workspace.activeFile), edited, 'utf8');
    assert.deepEqual(await manager.diff(workspace), [{
      file: workspace.activeFile,
      libraryId: '../Example',
      before: activeCql,
      after: edited,
      additions: 1,
      deletions: 1,
    }]);
  } finally {
    await manager.remove(workspace);
  }
});
