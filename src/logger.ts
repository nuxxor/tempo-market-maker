import { type LogEntry, type LogReason, type OrderSide, type FlipFailReason } from './types.js';
import { type Hash } from 'viem';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const LOG_COLORS = {
  info: '\x1b[36m',    // Cyan
  warn: '\x1b[33m',    // Yellow
  error: '\x1b[31m',   // Red
  debug: '\x1b[90m',   // Gray
  reset: '\x1b[0m',
} as const;

class Logger {
  private debugEnabled: boolean;

  constructor() {
    this.debugEnabled = process.env.DEBUG === 'true';
  }

  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  private formatLogEntry(entry: LogEntry): string {
    const parts: string[] = [];

    // Base info
    parts.push(`[${entry.reason.toUpperCase()}]`);

    // Pair and side
    if (entry.pair) {
      parts.push(`${entry.pair}`);
    }
    if (entry.side) {
      parts.push(`(${entry.side})`);
    }

    // Tick info
    if (entry.tick !== undefined) {
      parts.push(`tick=${entry.tick}`);
    }
    if (entry.flipTick !== undefined) {
      parts.push(`flipTick=${entry.flipTick}`);
    }

    // Order and tx
    if (entry.orderId) {
      parts.push(`orderId=${entry.orderId}`);
    }
    if (entry.txHash) {
      parts.push(`tx=${entry.txHash.slice(0, 10)}...`);
    }

    // Gas
    if (entry.gasUsed !== undefined) {
      parts.push(`gas=${entry.gasUsed}`);
    }

    // Message
    if (entry.message) {
      parts.push(`- ${entry.message}`);
    }

    // Fail reason
    if (entry.failReason) {
      parts.push(`failReason=${entry.failReason}`);
    }

    // Error
    if (entry.error) {
      parts.push(`ERROR: ${entry.error}`);
    }

    return parts.join(' ');
  }

  private log(level: LogLevel, entry: LogEntry): void {
    if (level === 'debug' && !this.debugEnabled) {
      return;
    }

    const timestamp = this.formatTimestamp();
    const color = LOG_COLORS[level];
    const reset = LOG_COLORS.reset;
    const levelTag = level.toUpperCase().padEnd(5);

    const formattedEntry = this.formatLogEntry(entry);

    console.log(`${color}${timestamp} [${levelTag}]${reset} ${formattedEntry}`);
  }

  // Main logging methods
  info(reason: LogReason, data?: Partial<LogEntry>): void {
    this.log('info', { ...data, reason, level: 'info', timestamp: this.formatTimestamp() } as LogEntry);
  }

  warn(reason: LogReason, data?: Partial<LogEntry>): void {
    this.log('warn', { ...data, reason, level: 'warn', timestamp: this.formatTimestamp() } as LogEntry);
  }

  error(reason: LogReason, data?: Partial<LogEntry>): void {
    this.log('error', { ...data, reason, level: 'error', timestamp: this.formatTimestamp() } as LogEntry);
  }

  debug(reason: LogReason, data?: Partial<LogEntry>): void {
    this.log('debug', { ...data, reason, level: 'debug', timestamp: this.formatTimestamp() } as LogEntry);
  }

  // Convenience methods for common log types
  txSuccess(params: {
    reason: LogReason;
    pair?: string;
    side?: OrderSide;
    tick?: number;
    flipTick?: number;
    orderId?: string;
    txHash: Hash;
    gasUsed?: bigint;
  }): void {
    this.info(params.reason, {
      ...params,
      message: 'Transaction successful',
    });
  }

  txFailed(params: {
    reason: LogReason;
    pair?: string;
    side?: OrderSide;
    error: string;
  }): void {
    this.error(params.reason, {
      ...params,
      message: 'Transaction failed',
    });
  }

  flipFailed(params: {
    pair: string;
    side: OrderSide;
    orderId: string;
    failReason: FlipFailReason;
    message?: string;
  }): void {
    this.warn('flipFailed', {
      ...params,
    });
  }

  orderFilled(params: {
    pair: string;
    side: OrderSide;
    orderId: string;
    tick: number;
    isPartial: boolean;
  }): void {
    this.info('orderFilled', {
      ...params,
      message: params.isPartial ? 'Partial fill' : 'Full fill',
    });
  }

  // Simple text logs
  text(level: LogLevel, message: string): void {
    const timestamp = this.formatTimestamp();
    const color = LOG_COLORS[level];
    const reset = LOG_COLORS.reset;
    const levelTag = level.toUpperCase().padEnd(5);

    console.log(`${color}${timestamp} [${levelTag}]${reset} ${message}`);
  }

  // Banner for startup
  banner(): void {
    console.log('\n');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         TEMPO STABLECOIN DEX - MARKET MAKER ENGINE        ║');
    console.log('║                     Reference Implementation              ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('\n');
  }
}

// Singleton export
export const logger = new Logger();
