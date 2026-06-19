/**
 * Unified logger — replaces scattered console.log calls.
 *
 * Levels: debug < info < warn < error
 * Production default: info (debug suppressed)
 *
 * Usage:
 *   import { logger } from './utils/logger';
 *   logger.debug('detail message', data);
 *   logger.info('user-facing info');
 *   logger.warn('something off');
 *   logger.error('failure', err);
 *
 * Set level at runtime:
 *   logger.setLevel('debug');  // verbose
 *   logger.setLevel('info');   // normal (default)
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const PREFIX = '[MarkVault]';

class Logger {
  private level: LogLevel = 'info';

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  debug(...args: unknown[]): void {
    if (LEVEL_PRIORITY[this.level] <= LEVEL_PRIORITY.debug) {
      console.log(PREFIX, ...args);
    }
  }

  info(...args: unknown[]): void {
    if (LEVEL_PRIORITY[this.level] <= LEVEL_PRIORITY.info) {
      console.log(PREFIX, ...args);
    }
  }

  warn(...args: unknown[]): void {
    if (LEVEL_PRIORITY[this.level] <= LEVEL_PRIORITY.warn) {
      console.warn(PREFIX, ...args);
    }
  }

  error(...args: unknown[]): void {
    if (LEVEL_PRIORITY[this.level] <= LEVEL_PRIORITY.error) {
      console.error(PREFIX, ...args);
    }
  }
}

export const logger = new Logger();
