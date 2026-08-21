import pino from 'pino';

export const openCodeLogger = pino({
  name: 'cql-studio-opencode',
  level: process.env.CQL_STUDIO_SERVER_LOG_LEVEL || process.env.OPENCODE_LOG_LEVEL || 'info',
  redact: {
    paths: [
      '*.authorization',
      '*.cookie',
      '*.capability',
      '*.prompt',
      '*.cqlContent',
      '*.toolOutput',
      '*.password',
      '*.token',
      '*.headers.authorization',
    ],
    censor: '[REDACTED]',
  },
});
