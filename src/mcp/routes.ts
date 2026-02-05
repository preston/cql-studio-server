// Author: Preston Lee

import express from 'express';
import { RateLimitError } from '../services/rate-limiter.js';
import { ToolExecutor } from './tools.js';

const router = express.Router();
const toolExecutor = new ToolExecutor();

/**
 * GET /tools
 * List all available MCP tools
 */
router.get('/tools', async (req, res) => {
  try {
    const tools = await toolExecutor.getAvailableTools();
    res.json(tools);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('[MCP] GET /tools failed:', err.message, err.stack ?? '');
    res.status(500).json({ error: 'Failed to get tools' });
  }
});

/**
 * POST /execute
 * Execute an MCP tool
 */
router.post('/execute', async (req, res) => {
  const method = req.body?.method;
  try {
    if (!method) {
      return res.status(400).json({ error: 'Missing method parameter' });
    }

    const params = req.body?.params ?? {};
    const result = await toolExecutor.executeTool(method, params);
    res.json({ result });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('[MCP] POST /execute failed', { method: method ?? '(missing)', error: err.message }, err.stack ?? '');
    if (err instanceof RateLimitError) {
      res.status(429).json({
        error: {
          code: err.code,
          message: err.message || 'Rate limit exceeded'
        }
      });
      return;
    }
    res.status(500).json({
      error: {
        code: -32000,
        message: err.message || 'Tool execution failed'
      }
    });
  }
});

/**
 * POST /fhir
 * Get FHIR data (legacy endpoint for compatibility)
 */
router.post('/fhir', async (req, res, next) => {
  try {
    res.status(501).json({
      error: 'FHIR endpoint not yet implemented'
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('[MCP] POST /fhir failed:', err.message, err.stack ?? '');
    next(err);
  }
});

export { router as mcpRouter };
