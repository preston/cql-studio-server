// Author: Preston Lee

import express from 'express';
import cors from 'cors';
import { mcpRouter } from './mcp/index.js';

const app = express();
const PORT = process.env.CQL_STUDIO_SERVER_PORT || 3003;
const isDev = (process.env.CQL_STUDIO_SERVER_NODE_ENV || 'development') === 'development';

/**
 * Wraps async route handlers so rejections are passed to Express error middleware.
 * Express does not catch async errors by default; this ensures they are handled.
 */
function asyncHandler(
  fn: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>
): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// CORS configuration - allow all origins
const corsOptions = {
  origin: '*',
  credentials: false,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// MCP routes
app.use('/', mcpRouter);

// Error handling middleware (must have 4 args for Express to treat as error handler)
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err?.message || 'Internal server error';
  console.error(`[Error] ${req.method} ${req.path} - ${message}`, isDev && err?.stack ? err.stack : '');
  if (!res.headersSent) {
    res.status(500).json({ error: message });
  }
});

// 404 handler
app.use((req, res) => {
  console.warn(`${new Date().toISOString()} - 404 ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`CQL Studio Server listening on port ${PORT}`);
  console.log(`Environment: ${process.env.CQL_STUDIO_SERVER_NODE_ENV || 'development'}`);
  console.log(`CORS origin: * (allowing all origins)`);
});

