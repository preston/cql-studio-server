// Author: Preston Lee

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { loadEnv } from './config/env.js';
import { applyPendingMigrations } from './db/migrate.js';
import { mcpRouter } from './mcp/index.js';
import { ollamaProxyRouter } from './ollama/proxy.js';
import { vsacFhirProxyRouter, vsacSiteProxyRouter } from './vsac/proxy.js';
import { createAuthRouter } from './auth/routes.js';
import { createTeamRouter } from './team/routes.js';
import { createActivityRouter, createWorkspaceRouter } from './workspace/routes.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const isDev = env.nodeEnv === 'development';

  await applyPendingMigrations(env);

  const app = express();

  app.use(
    cors({
      origin: env.ssoConfigured ? env.corsOrigin : '*',
      credentials: env.ssoConfigured,
      optionsSuccessStatus: 200,
    })
  );
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      ssoEnabled: env.ssoConfigured,
    });
  });

  app.use('/', mcpRouter);
  app.use('/api/ollama', ollamaProxyRouter);
  app.use('/api/vsac/fhir', vsacFhirProxyRouter);
  app.use('/api/vsac/site', vsacSiteProxyRouter);

  if (env.ssoConfigured) {
    app.use('/api/auth', createAuthRouter(env));
    app.use('/api/teams', createTeamRouter(env));
    app.use('/api/workspaces', createWorkspaceRouter(env));
    app.use('/api/activity', createActivityRouter(env));
  } else {
    app.get('/api/auth/session', (_req, res) => {
      res.json({ enabled: false, user: null });
    });
  }

  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const oauthErr = err as Error & { error?: string; error_description?: string };
    const oauthDetail =
      oauthErr.error
        ? `${oauthErr.error}${oauthErr.error_description ? `: ${oauthErr.error_description}` : ''}`
        : '';
    const message = oauthDetail || err?.message || 'Internal server error';
    console.error(`[Error] ${req.method} ${req.path} - ${message}`, isDev && err?.stack ? err.stack : '');
    if (!res.headersSent) {
      res.status(oauthErr.error === 'access_denied' ? 403 : 500).json({
        error: message,
        ...(oauthErr.error && { oauthError: oauthErr.error }),
        ...(oauthErr.error_description && { oauthErrorDescription: oauthErr.error_description }),
      });
    }
  });

  app.use((req, res) => {
    console.warn(`${new Date().toISOString()} - 404 ${req.method} ${req.path}`);
    res.status(404).json({ error: 'Not found' });
  });

  app.listen(env.port, () => {
    console.log(`CQL Studio Server listening on port ${env.port}`);
    console.log(`Environment: ${env.nodeEnv}`);
    console.log(`SSO: ${env.ssoConfigured ? 'enabled' : 'disabled'}`);
    if (env.ssoConfigured) {
      console.log(`UI base URL: ${env.uiBaseUrl}`);
    }
    console.log(
      `CORS origin: ${env.ssoConfigured ? env.corsOrigin + ' (credentials)' : '* (allowing all origins)'}`
    );
  });
}

main().catch((err) => {
  console.error('[startup] Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
