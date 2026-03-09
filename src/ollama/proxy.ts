// Author: Preston Lee

import { Readable } from 'node:stream';
import express from 'express';

const router = express.Router();

const CQL_STUDIO_SERVER_OLLAMA_BASE_URL = 'x-ollama-base-url';

function getOllamaBaseUrl(req: express.Request): string | null {
  const header = req.headers[CQL_STUDIO_SERVER_OLLAMA_BASE_URL];
  if (typeof header === 'string' && header.trim() !== '') {
    return header.trim();
  }
  const query = req.query?.ollamaBaseUrl;
  if (typeof query === 'string' && query.trim() !== '') {
    return query.trim();
  }
  return null;
}

function isValidOllamaUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

async function proxyGet(baseUrl: string, path: string, res: express.Response): Promise<boolean> {
  const target = `${normalizeBaseUrl(baseUrl)}/api/${path}`;
  const response = await fetch(target, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });
  const contentType = response.headers.get('content-type') || 'application/json';
  res.setHeader('Content-Type', contentType);
  if (!response.ok) {
    const text = await response.text();
    res.status(response.status).send(text);
    return false;
  }
  const data = await response.json();
  res.status(response.status).json(data);
  return true;
}

router.get('/tags', async (req, res, next) => {
  try {
    const baseUrl = getOllamaBaseUrl(req);
    if (!baseUrl || !isValidOllamaUrl(baseUrl)) {
      res.status(400).json({ error: 'Missing or invalid X-Ollama-Base-URL (must be http or https URL)' });
      return;
    }
    await proxyGet(baseUrl, 'tags', res);
  } catch (err) {
    next(err);
  }
});

router.get('/version', async (req, res, next) => {
  try {
    const baseUrl = getOllamaBaseUrl(req);
    if (!baseUrl || !isValidOllamaUrl(baseUrl)) {
      res.status(400).json({ error: 'Missing or invalid X-Ollama-Base-URL (must be http or https URL)' });
      return;
    }
    await proxyGet(baseUrl, 'version', res);
  } catch (err) {
    next(err);
  }
});

async function proxyPost(
  baseUrl: string,
  path: string,
  req: express.Request,
  res: express.Response,
  streamKey: 'stream' = 'stream'
): Promise<boolean> {
  const target = `${normalizeBaseUrl(baseUrl)}/api/${path}`;
  const body = req.body != null ? JSON.stringify(req.body) : '{}';
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    const contentType = response.headers.get('content-type') || 'text/plain';
    res.status(response.status).setHeader('Content-Type', contentType).send(text);
    return false;
  }

  const stream = (req.body as { [k: string]: boolean })?.[streamKey] === true;
  if (stream && response.body) {
    const contentType = response.headers.get('content-type') || 'application/json';
    res.status(response.status).setHeader('Content-Type', contentType);
    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.pipe(res);
    return true;
  }

  const data = await response.json();
  const ct = response.headers.get('content-type') || 'application/json';
  res.setHeader('Content-Type', ct).status(response.status).json(data);
  return true;
}

router.post('/show', async (req, res, next) => {
  try {
    const baseUrl = getOllamaBaseUrl(req);
    if (!baseUrl || !isValidOllamaUrl(baseUrl)) {
      res.status(400).json({ error: 'Missing or invalid X-Ollama-Base-URL (must be http or https URL)' });
      return;
    }
    await proxyPost(baseUrl, 'show', req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/chat', async (req, res, next) => {
  try {
    const baseUrl = getOllamaBaseUrl(req);
    if (!baseUrl || !isValidOllamaUrl(baseUrl)) {
      res.status(400).json({ error: 'Missing or invalid X-Ollama-Base-URL (must be http or https URL)' });
      return;
    }
    await proxyPost(baseUrl, 'chat', req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/generate', async (req, res, next) => {
  try {
    const baseUrl = getOllamaBaseUrl(req);
    if (!baseUrl || !isValidOllamaUrl(baseUrl)) {
      res.status(400).json({ error: 'Missing or invalid X-Ollama-Base-URL (must be http or https URL)' });
      return;
    }
    await proxyPost(baseUrl, 'generate', req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/embeddings', async (req, res, next) => {
  try {
    const baseUrl = getOllamaBaseUrl(req);
    if (!baseUrl || !isValidOllamaUrl(baseUrl)) {
      res.status(400).json({ error: 'Missing or invalid X-Ollama-Base-URL (must be http or https URL)' });
      return;
    }
    await proxyPost(baseUrl, 'embeddings', req, res);
  } catch (err) {
    next(err);
  }
});

export { router as ollamaProxyRouter };
