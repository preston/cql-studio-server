// Author: Preston Lee

import express from 'express';
import cors from 'cors';
import { mcpRouter } from './routes/mcp.js';

const app = express();
const PORT = process.env.CQL_STUDIO_SERVER_PORT || 3003;

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

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`CQL Studio Server listening on port ${PORT}`);
  console.log(`Environment: ${process.env.CQL_STUDIO_SERVER_NODE_ENV || 'development'}`);
  console.log(`CORS origin: * (allowing all origins)`);
});

