/**
 * Structured console logger implementing the `Logger` port.
 *
 * JSON lines so a log shipper can parse them; no dependency, because a logging
 * library is not worth one for this.
 */

import type { LogLevel, Logger } from '@acc/domain';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel = 'info', bindings: Record<string, unknown> = {}): Logger {
  const threshold = LEVELS[level];

  function emit(logLevel: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVELS[logLevel] < threshold) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: logLevel,
      message,
      ...bindings,
      ...context,
    });
    if (logLevel === 'error') console.error(line);
    else if (logLevel === 'warn') console.warn(line);
    else console.log(line);
  }

  return {
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}
