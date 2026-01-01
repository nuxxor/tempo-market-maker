/**
 * State Management - JSON persistence for restart recovery
 *
 * Handles:
 * - state.json read/write
 * - Order tracking per pair
 * - TX counters (daily limit, hourly cancels)
 * - Reconciliation with chain state
 */

import * as fs from 'fs';
import * as path from 'path';
import { type TokenSymbol, config } from './config.js';
import { getOrder } from './dex.js';
import { logger } from './logger.js';
import { type OrderInfo, orderIdToString, stringToOrderId } from './types.js';

// State file path
const STATE_FILE = path.join(process.cwd(), 'state.json');

// Schema version for migrations
const SCHEMA_VERSION = 1;

/**
 * Per-pair order state
 */
export interface PairState {
  base: TokenSymbol;
  quote: TokenSymbol;
  bidOrderId: string | null;  // Decimal string
  askOrderId: string | null;  // Decimal string
  lastBidTick: number | null;
  lastAskTick: number | null;
  lastBidFlipTick: number | null;
  lastAskFlipTick: number | null;
  updatedAt: string;
}

/**
 * TX counter state for budget enforcement
 */
export interface TxCounters {
  dailyTxCount: number;
  dailyResetAt: string;  // ISO date string
  hourlyCancelCount: number;
  hourlyResetAt: string; // ISO date string
}

/**
 * Full engine state
 */
export interface EngineState {
  schemaVersion: number;
  makerAddress: string;
  pairs: PairState[];
  lastProcessedBlock: number;
  txCounters: TxCounters;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create default state
 */
function createDefaultState(makerAddress: string): EngineState {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    makerAddress,
    pairs: [],
    lastProcessedBlock: 0,
    txCounters: {
      dailyTxCount: 0,
      dailyResetAt: now,
      hourlyCancelCount: 0,
      hourlyResetAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Create default pair state
 */
function createDefaultPairState(base: TokenSymbol, quote: TokenSymbol): PairState {
  return {
    base,
    quote,
    bidOrderId: null,
    askOrderId: null,
    lastBidTick: null,
    lastAskTick: null,
    lastBidFlipTick: null,
    lastAskFlipTick: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Load state from file
 */
export function loadState(makerAddress: string): EngineState {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      logger.info('state', { message: 'No state file found, creating new state' });
      const state = createDefaultState(makerAddress);
      saveState(state);
      return state;
    }

    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw) as EngineState;

    // Validate schema version
    if (state.schemaVersion !== SCHEMA_VERSION) {
      logger.warn('state', {
        message: `State schema version mismatch (file: ${state.schemaVersion}, expected: ${SCHEMA_VERSION})`,
      });
      // For now, just reset state on version mismatch
      const newState = createDefaultState(makerAddress);
      saveState(newState);
      return newState;
    }

    // Validate maker address
    if (state.makerAddress.toLowerCase() !== makerAddress.toLowerCase()) {
      logger.warn('state', {
        message: 'Maker address mismatch, creating new state',
        stateAddress: state.makerAddress,
        currentAddress: makerAddress,
      });
      const newState = createDefaultState(makerAddress);
      saveState(newState);
      return newState;
    }

    logger.info('state', {
      message: 'Loaded state from file',
      pairs: state.pairs.length,
      lastBlock: state.lastProcessedBlock,
    });

    return state;
  } catch (error) {
    logger.error('state', {
      message: 'Failed to load state, creating new',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    const state = createDefaultState(makerAddress);
    saveState(state);
    return state;
  }
}

/**
 * Save state to file
 */
export function saveState(state: EngineState): void {
  try {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    logger.error('state', {
      message: 'Failed to save state',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Get or create pair state
 */
export function getPairState(state: EngineState, base: TokenSymbol, quote: TokenSymbol): PairState {
  let pairState = state.pairs.find(
    p => p.base === base && p.quote === quote
  );

  if (!pairState) {
    pairState = createDefaultPairState(base, quote);
    state.pairs.push(pairState);
    saveState(state);
  }

  return pairState;
}

/**
 * Update pair order IDs
 */
export function updatePairOrders(
  state: EngineState,
  base: TokenSymbol,
  quote: TokenSymbol,
  updates: {
    bidOrderId?: string | null;
    askOrderId?: string | null;
    lastBidTick?: number | null;
    lastAskTick?: number | null;
    lastBidFlipTick?: number | null;
    lastAskFlipTick?: number | null;
  }
): void {
  const pairState = getPairState(state, base, quote);

  if (updates.bidOrderId !== undefined) pairState.bidOrderId = updates.bidOrderId;
  if (updates.askOrderId !== undefined) pairState.askOrderId = updates.askOrderId;
  if (updates.lastBidTick !== undefined) pairState.lastBidTick = updates.lastBidTick;
  if (updates.lastAskTick !== undefined) pairState.lastAskTick = updates.lastAskTick;
  if (updates.lastBidFlipTick !== undefined) pairState.lastBidFlipTick = updates.lastBidFlipTick;
  if (updates.lastAskFlipTick !== undefined) pairState.lastAskFlipTick = updates.lastAskFlipTick;

  pairState.updatedAt = new Date().toISOString();
  saveState(state);
}

/**
 * Increment TX counters and check budget
 */
export function incrementTxCounter(state: EngineState, isCancel: boolean = false): {
  allowed: boolean;
  dailyRemaining: number;
  hourlyRemaining: number;
} {
  const now = new Date();

  // Reset daily counter if needed (new day)
  const dailyResetDate = new Date(state.txCounters.dailyResetAt);
  if (now.getDate() !== dailyResetDate.getDate() ||
      now.getMonth() !== dailyResetDate.getMonth() ||
      now.getFullYear() !== dailyResetDate.getFullYear()) {
    state.txCounters.dailyTxCount = 0;
    state.txCounters.dailyResetAt = now.toISOString();
  }

  // Reset hourly cancel counter if needed
  const hourlyResetDate = new Date(state.txCounters.hourlyResetAt);
  const hoursDiff = (now.getTime() - hourlyResetDate.getTime()) / (1000 * 60 * 60);
  if (hoursDiff >= 1) {
    state.txCounters.hourlyCancelCount = 0;
    state.txCounters.hourlyResetAt = now.toISOString();
  }

  // Check budget
  const dailyRemaining = config.MAX_TX_PER_DAY - state.txCounters.dailyTxCount;
  const hourlyRemaining = isCancel
    ? config.MAX_CANCELS_PER_HOUR - state.txCounters.hourlyCancelCount
    : Infinity;

  const allowed = dailyRemaining > 0 && (isCancel ? hourlyRemaining > 0 : true);

  if (allowed) {
    state.txCounters.dailyTxCount++;
    if (isCancel) {
      state.txCounters.hourlyCancelCount++;
    }
    saveState(state);
  }

  return {
    allowed,
    dailyRemaining: Math.max(0, dailyRemaining - 1),
    hourlyRemaining: isCancel ? Math.max(0, hourlyRemaining - 1) : Infinity,
  };
}

/**
 * Check if TX budget allows operation
 */
export function checkTxBudget(state: EngineState, isCancel: boolean = false): {
  allowed: boolean;
  dailyRemaining: number;
  hourlyRemaining: number;
} {
  const now = new Date();

  // Check daily reset
  const dailyResetDate = new Date(state.txCounters.dailyResetAt);
  let dailyCount = state.txCounters.dailyTxCount;
  if (now.getDate() !== dailyResetDate.getDate() ||
      now.getMonth() !== dailyResetDate.getMonth() ||
      now.getFullYear() !== dailyResetDate.getFullYear()) {
    dailyCount = 0;
  }

  // Check hourly reset
  const hourlyResetDate = new Date(state.txCounters.hourlyResetAt);
  let hourlyCount = state.txCounters.hourlyCancelCount;
  const hoursDiff = (now.getTime() - hourlyResetDate.getTime()) / (1000 * 60 * 60);
  if (hoursDiff >= 1) {
    hourlyCount = 0;
  }

  const dailyRemaining = config.MAX_TX_PER_DAY - dailyCount;
  const hourlyRemaining = isCancel
    ? config.MAX_CANCELS_PER_HOUR - hourlyCount
    : Infinity;

  return {
    allowed: dailyRemaining > 0 && (isCancel ? hourlyRemaining > 0 : true),
    dailyRemaining,
    hourlyRemaining: isCancel ? hourlyRemaining : Infinity,
  };
}

/**
 * Update last processed block
 */
export function updateLastBlock(state: EngineState, blockNumber: number): void {
  if (blockNumber > state.lastProcessedBlock) {
    state.lastProcessedBlock = blockNumber;
    saveState(state);
  }
}

/**
 * Reconcile state with chain - verify order IDs are still valid
 * Returns list of orders that no longer exist on chain
 */
export async function reconcileOrders(
  state: EngineState,
  base: TokenSymbol,
  quote: TokenSymbol
): Promise<{
  bidValid: boolean;
  askValid: boolean;
  staleOrderIds: string[];
}> {
  const pairState = getPairState(state, base, quote);
  const staleOrderIds: string[] = [];
  let bidValid = false;
  let askValid = false;

  // Check bid order
  if (pairState.bidOrderId) {
    const bidOrderIdCopy = pairState.bidOrderId;
    try {
      const orderId = stringToOrderId(bidOrderIdCopy);
      const order = await getOrder(orderId);
      if (order && order.remainingAmount > 0n) {
        bidValid = true;
        logger.debug('state', {
          message: `Bid order ${bidOrderIdCopy} still active`,
          remaining: order.remainingAmount.toString(),
        });
      } else {
        staleOrderIds.push(bidOrderIdCopy);
        pairState.bidOrderId = null;
        logger.info('state', {
          message: `Bid order ${bidOrderIdCopy} no longer active`,
        });
      }
    } catch {
      staleOrderIds.push(bidOrderIdCopy);
      pairState.bidOrderId = null;
    }
  }

  // Check ask order
  if (pairState.askOrderId) {
    const askOrderIdCopy = pairState.askOrderId;
    try {
      const orderId = stringToOrderId(askOrderIdCopy);
      const order = await getOrder(orderId);
      if (order && order.remainingAmount > 0n) {
        askValid = true;
        logger.debug('state', {
          message: `Ask order ${askOrderIdCopy} still active`,
          remaining: order.remainingAmount.toString(),
        });
      } else {
        staleOrderIds.push(askOrderIdCopy);
        pairState.askOrderId = null;
        logger.info('state', {
          message: `Ask order ${askOrderIdCopy} no longer active`,
        });
      }
    } catch {
      staleOrderIds.push(askOrderIdCopy);
      pairState.askOrderId = null;
    }
  }

  if (staleOrderIds.length > 0) {
    saveState(state);
  }

  return { bidValid, askValid, staleOrderIds };
}

/**
 * Full chain reconciliation - verify state's orders still exist on chain
 * Use this on startup or after suspected state corruption
 *
 * Note: We can't query all maker orders because dex_getOrders RPC doesn't return
 * our orders reliably. Instead, we verify each order in state using getOrder.
 */
export async function fullReconcile(
  state: EngineState,
  base: TokenSymbol,
  quote: TokenSymbol
): Promise<{
  foundBid: OrderInfo | null;
  foundAsk: OrderInfo | null;
  orphanedOrders: OrderInfo[];
}> {
  const pairState = getPairState(state, base, quote);

  let foundBid: OrderInfo | null = null;
  let foundAsk: OrderInfo | null = null;

  // Check bid order via getOrder
  if (pairState.bidOrderId) {
    try {
      const orderId = stringToOrderId(pairState.bidOrderId);
      const order = await getOrder(orderId);
      if (order && order.remainingAmount > 0n) {
        foundBid = order;
        pairState.lastBidTick = order.tick;
        pairState.lastBidFlipTick = order.flipTick;
        logger.debug('state', {
          message: `Bid order ${pairState.bidOrderId} verified on chain`,
          remaining: order.remainingAmount.toString(),
        });
      } else {
        logger.warn('state', {
          message: `Bid order ${pairState.bidOrderId} not found on chain, clearing`,
        });
        pairState.bidOrderId = null;
        pairState.lastBidTick = null;
        pairState.lastBidFlipTick = null;
      }
    } catch {
      logger.warn('state', {
        message: `Bid order ${pairState.bidOrderId} not found on chain, clearing`,
      });
      pairState.bidOrderId = null;
      pairState.lastBidTick = null;
      pairState.lastBidFlipTick = null;
    }
  }

  // Check ask order via getOrder
  if (pairState.askOrderId) {
    try {
      const orderId = stringToOrderId(pairState.askOrderId);
      const order = await getOrder(orderId);
      if (order && order.remainingAmount > 0n) {
        foundAsk = order;
        pairState.lastAskTick = order.tick;
        pairState.lastAskFlipTick = order.flipTick;
        logger.debug('state', {
          message: `Ask order ${pairState.askOrderId} verified on chain`,
          remaining: order.remainingAmount.toString(),
        });
      } else {
        logger.warn('state', {
          message: `Ask order ${pairState.askOrderId} not found on chain, clearing`,
        });
        pairState.askOrderId = null;
        pairState.lastAskTick = null;
        pairState.lastAskFlipTick = null;
      }
    } catch {
      logger.warn('state', {
        message: `Ask order ${pairState.askOrderId} not found on chain, clearing`,
      });
      pairState.askOrderId = null;
      pairState.lastAskTick = null;
      pairState.lastAskFlipTick = null;
    }
  }

  const foundCount = (foundBid ? 1 : 0) + (foundAsk ? 1 : 0);
  logger.info('state', {
    message: `Full reconcile: verified ${foundCount} orders on chain`,
    baseToken: base,
  });

  pairState.updatedAt = new Date().toISOString();
  saveState(state);

  // Note: We can't detect orphaned orders since dex_getOrders doesn't work
  // Orphaned orders will eventually fill or be cancelled manually
  return { foundBid, foundAsk, orphanedOrders: [] };
}

/**
 * Clear all order state for a pair (use after manual intervention)
 */
export function clearPairState(
  state: EngineState,
  base: TokenSymbol,
  quote: TokenSymbol
): void {
  const pairState = getPairState(state, base, quote);
  pairState.bidOrderId = null;
  pairState.askOrderId = null;
  pairState.lastBidTick = null;
  pairState.lastAskTick = null;
  pairState.lastBidFlipTick = null;
  pairState.lastAskFlipTick = null;
  pairState.updatedAt = new Date().toISOString();
  saveState(state);
  logger.info('state', { message: `Cleared state for ${base}/${quote}` });
}

/**
 * Format state for display
 */
export function formatState(state: EngineState): string {
  const lines: string[] = [
    `Schema: v${state.schemaVersion}`,
    `Maker: ${state.makerAddress}`,
    `Last Block: ${state.lastProcessedBlock}`,
    `TX Budget: ${state.txCounters.dailyTxCount} daily, ${state.txCounters.hourlyCancelCount} cancels/hour`,
    '',
    'Pairs:',
  ];

  for (const pair of state.pairs) {
    lines.push(`  ${pair.base}/${pair.quote}:`);
    lines.push(`    Bid: ${pair.bidOrderId || 'none'} @ tick ${pair.lastBidTick ?? 'n/a'}`);
    lines.push(`    Ask: ${pair.askOrderId || 'none'} @ tick ${pair.lastAskTick ?? 'n/a'}`);
    lines.push(`    Updated: ${pair.updatedAt}`);
  }

  return lines.join('\n');
}
