import pino from 'pino';
import config from '../../config/default.js';

// Shared structured logger built on pino.
// All modules call logger.child({ module: 'ModuleName' }) to get a child
// logger that automatically includes the module name in every log line.
// Log level is controlled by the LOG_LEVEL environment variable.
// In production, set LOG_LEVEL=info. For debugging, set LOG_LEVEL=debug.
// Output format:
//   - development : pino-pretty (human-readable, coloured)
//   - production  : newline-delimited JSON (machine-readable)

const isDev = (process.env.NODE_ENV ?? 'development') === 'development';

const transport = isDev
  ? {
      target:  'pino-pretty',
      options: {
        colorize:        true,
        translateTime:   'SYS:HH:MM:ss.l',
        ignore:          'pid,hostname',
        messageFormat:   '[{module}] {msg}',
      },
    }
  : undefined;  // default pino JSON output in production

const logger = pino(
  {
    level:     process.env.LOG_LEVEL ?? config.logging.level ?? 'info',
    base:      { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport ? pino.transport(transport) : undefined,
);

export default logger;