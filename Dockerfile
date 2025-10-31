# Author: Preston Lee

FROM node:25-alpine

WORKDIR /app

# Copy package files and TypeScript config
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci && npm cache clean --force

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --production

# Expose port
EXPOSE 3003

# Set environment variables
ENV CQL_STUDIO_SERVER_NODE_ENV=production
ENV CQL_STUDIO_SERVER_PORT=3003

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "import('node:http').then(m => {const req = m.request('http://localhost:3003/health', {timeout: 2000}, (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}); req.on('error', () => process.exit(1)); req.end();})"

# Start server
CMD ["node", "dist/server.js"]

