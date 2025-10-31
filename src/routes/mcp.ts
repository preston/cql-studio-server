// Author: Preston Lee

import express from 'express';
import { ToolExecutor } from '../services/tool-executor.js';

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
    console.error('Error getting tools:', error);
    res.status(500).json({ error: 'Failed to get tools' });
  }
});

/**
 * POST /execute
 * Execute an MCP tool
 */
router.post('/execute', async (req, res) => {
  try {
    const { method, params } = req.body;
    
    if (!method) {
      return res.status(400).json({ error: 'Missing method parameter' });
    }

    const result = await toolExecutor.executeTool(method, params || {});
    
    res.json({ result });
  } catch (error: any) {
    console.error('Error executing tool:', error);
    res.status(500).json({
      error: {
        code: -32000,
        message: error.message || 'Tool execution failed'
      }
    });
  }
});

/**
 * POST /fhir
 * Get FHIR data (legacy endpoint for compatibility)
 */
router.post('/fhir', async (req, res) => {
  try {
    const { resourceType, id, query } = req.body;
    
    // This can be implemented later if needed
    // For now, return a helpful error
    res.status(501).json({
      error: 'FHIR endpoint not yet implemented'
    });
  } catch (error: any) {
    console.error('Error in FHIR endpoint:', error);
    res.status(500).json({ error: error.message || 'FHIR request failed' });
  }
});

export { router as mcpRouter };

