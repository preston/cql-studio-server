/**
 * VSAC proxy: validates URL building and host allowlist (fetch mocked).
 */

import { test, mock } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { vsacFhirProxyRouter, vsacSiteProxyRouter } from '../src/vsac/proxy.js';

const FHIR_BASE_HEADER = 'x-vsac-fhir-base-url';

const realFetch = globalThis.fetch;

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/vsac/fhir', vsacFhirProxyRouter);
  app.use('/api/vsac/site', vsacSiteProxyRouter);
  return app;
}

async function withServer(
  app: express.Express,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      fn(baseUrl)
        .then(() => {
          server.close();
          resolve();
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
    server.on('error', reject);
  });
}

test('FHIR proxy rejects disallowed X-VSAC-FHIR-Base-URL host', async () => {
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/vsac/fhir/metadata`, {
      headers: { [FHIR_BASE_HEADER]: 'https://evil.example/fhir' }
    });
    assert.strictEqual(res.status, 400);
  });
});

test('FHIR proxy forwards to CTS metadata URL', async () => {
  const mockFetch = mock.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : (input as URL).href;
    if (url.includes('127.0.0.1') || url.includes('localhost')) {
      return realFetch(input, init);
    }
    assert.strictEqual(url, 'https://cts.nlm.nih.gov/fhir/metadata');
    return new Response('{"resourceType":"CapabilityStatement"}', {
      status: 200,
      headers: { 'Content-Type': 'application/fhir+json' }
    });
  });
  globalThis.fetch = mockFetch as typeof fetch;

  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/vsac/fhir/metadata`, {
      headers: { [FHIR_BASE_HEADER]: 'https://cts.nlm.nih.gov/fhir' }
    });
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('CapabilityStatement'));
  });

  mockFetch.mock.restore();
});

test('Site proxy rejects path not under /vsac/', async () => {
  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/vsac/site/evil`);
    assert.strictEqual(res.status, 400);
  });
});

test('Site proxy forwards vsac programs path', async () => {
  const mockFetch = mock.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : (input as URL).href;
    if (url.includes('127.0.0.1') || url.includes('localhost')) {
      return realFetch(input, init);
    }
    assert.strictEqual(url, 'https://vsac.nlm.nih.gov/vsac/programs');
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  globalThis.fetch = mockFetch as typeof fetch;

  const app = createApp();
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/vsac/site/vsac/programs`);
    assert.strictEqual(res.status, 200);
  });

  mockFetch.mock.restore();
});
