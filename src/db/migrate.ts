// Author: Preston Lee

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerEnv } from '../config/env.js';

const execFileAsync = promisify(execFile);

/**
 * Applies pending Prisma migrations (forward-only) before the HTTP server accepts traffic.
 * Only runs when SSO/team features are enabled (database required).
 */
export async function applyPendingMigrations(env: ServerEnv): Promise<void> {
  if (!env.ssoConfigured) {
    return;
  }
  if (!env.databaseUrl) {
    throw new Error('CQL_STUDIO_SERVER_DATABASE_URL is required to apply migrations');
  }

  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const prismaCli = path.join(serverRoot, 'node_modules', 'prisma', 'build', 'index.js');

  console.log('[migrate] Checking for pending PostgreSQL schema migrations…');
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [prismaCli, 'migrate', 'deploy'],
      {
        cwd: serverRoot,
        env: {
          ...process.env,
          CQL_STUDIO_SERVER_DATABASE_URL: env.databaseUrl,
        },
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    if (stdout?.trim()) {
      console.log(stdout.trim());
    }
    if (stderr?.trim()) {
      console.warn(stderr.trim());
    }
    console.log('[migrate] Schema is up to date.');
  } catch (err) {
    const error = err as Error & { stdout?: string; stderr?: string };
    const detail = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n');
    throw new Error(`Failed to apply Prisma migrations:\n${detail}`);
  }
}
