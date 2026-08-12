# Author: Preston Lee
FROM node:26-alpine

WORKDIR /app

# Copy package files and TypeScript config
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci && npm cache clean --force

# Generate Prisma client and build TypeScript
COPY src ./src
RUN npx prisma generate && npm run build

# Keep prisma CLI in production for startup migrate deploy
RUN npm prune --production

# Expose port
EXPOSE 3003

# Set environment variables
ENV CQL_STUDIO_SERVER_NODE_ENV=production
ENV CQL_STUDIO_SERVER_PORT=3003

# Health check — allow time for migrate-on-startup when SSO/DB is configured
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "import('node:http').then(m => {const req = m.request('http://localhost:3003/health', {timeout: 2000}, (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}); req.on('error', () => process.exit(1)); req.end();})"

# Start server (applies pending Prisma migrations when SSO/DB is configured)
CMD ["node", "dist/server.js"]

