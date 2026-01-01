/**
 * Engine - Main bot loop and orchestration
 *
 * State machine:
 * IDLE → BOOTSTRAP → RUNNING → COOLDOWN → RUNNING ...
 *
 * Handles:
 * - Startup reconciliation
 * - Two-sided quoting (bid + ask flip orders)
 * - Event-driven order management
 * - Flip fail detection and recovery
 * - TX budget enforcement
 */

import { type Hash, type Log } from 'viem';
import { config, type TokenSymbol } from './config.js';
import { getMakerAddress, getPublicClientHttp } from './client.js';
import { logger } from './logger.js';
import {
  placeFlipOrder,
  cancelOrder,
  ensurePairExists,
  getMakerOrders,
  getOrder,
} from './dex.js';
import {
  getQuoteParams,
  getInventoryState,
  formatQuoteParams,
  formatInventory,
  canQuotePair,
  hasFlipBuffer,
  type QuoteParams,
} from './strategy.js';
import {
  loadState,
  saveState,
  getPairState,
  updatePairOrders,
  incrementTxCounter,
  checkTxBudget,
  reconcileOrders,
  fullReconcile,
  formatState,
  type EngineState,
} from './state.js';
import { orderIdToString, type OrderInfo } from './types.js';
import { ensureAllowance, getTokenAddress } from './tokens.js';

// Engine states
type EngineStatus = 'IDLE' | 'BOOTSTRAP' | 'RUNNING' | 'COOLDOWN' | 'STOPPED';

// Engine context
interface EngineContext {
  status: EngineStatus;
  state: EngineState;
  makerAddress: string;
  lastQuoteTime: Map<string, number>; // pair -> timestamp
  stopRequested: boolean;
}

// Pair key helper
function pairKey(base: TokenSymbol, quote: TokenSymbol): string {
  return `${base}/${quote}`;
}

/**
 * Initialize engine context
 */
function createContext(): EngineContext {
  const makerAddress = getMakerAddress();
  const state = loadState(makerAddress);

  return {
    status: 'IDLE',
    state,
    makerAddress,
    lastQuoteTime: new Map(),
    stopRequested: false,
  };
}

/**
 * Bootstrap phase - verify prerequisites and reconcile state
 */
async function bootstrap(ctx: EngineContext): Promise<boolean> {
  ctx.status = 'BOOTSTRAP';
  logger.text('info', '\n=== BOOTSTRAP PHASE ===\n');

  const enabledPairs = config.pairs.filter(p => p.enabled);

  for (const pair of enabledPairs) {
    const key = pairKey(pair.base, pair.quote);
    logger.text('info', `Bootstrapping ${key}...`);

    // 1. Ensure pair exists on DEX
    logger.text('info', '  Checking pair exists...');
    const pairOk = await ensurePairExists(pair.base);
    if (!pairOk) {
      logger.error('bootstrap', {
        message: `Failed to ensure pair ${key} exists`,
      });
      return false;
    }
    logger.text('info', '  ✅ Pair exists');

    // 2. Ensure allowances
    logger.text('info', '  Checking allowances...');
    const baseAddress = getTokenAddress(pair.base);
    const quoteAddress = getTokenAddress(pair.quote);

    const baseApproved = await ensureAllowance(baseAddress);
    const quoteApproved = await ensureAllowance(quoteAddress);

    if (!baseApproved || !quoteApproved) {
      logger.error('bootstrap', {
        message: `Allowance check failed for ${key}`,
        baseApproved,
        quoteApproved,
      });
      return false;
    }
    logger.text('info', '  ✅ Allowances OK');

    // 3. Check inventory
    logger.text('info', '  Checking inventory...');
    const inventory = await getInventoryState(pair.base, pair.quote);
    logger.text('info', formatInventory(inventory));

    // 4. Check if we can quote
    const canQuote = await canQuotePair(pair.base, pair.quote);
    if (!canQuote.canQuote) {
      logger.warn('bootstrap', {
        message: `Cannot quote ${key}: ${canQuote.reason}`,
      });
      continue; // Skip this pair but continue with others
    }
    logger.text('info', '  ✅ Can quote');

    // 5. Reconcile orders with chain
    logger.text('info', '  Reconciling orders with chain...');
    const reconciled = await fullReconcile(ctx.state, pair.base, pair.quote);

    if (reconciled.foundBid) {
      logger.text('info', `  Found existing bid: ${orderIdToString(reconciled.foundBid.orderId)}`);
    }
    if (reconciled.foundAsk) {
      logger.text('info', `  Found existing ask: ${orderIdToString(reconciled.foundAsk.orderId)}`);
    }
    if (reconciled.orphanedOrders.length > 0) {
      logger.warn('bootstrap', {
        message: `Found ${reconciled.orphanedOrders.length} orphaned orders`,
      });
    }

    logger.text('info', `  ✅ ${key} ready\n`);
  }

  logger.text('info', '=== BOOTSTRAP COMPLETE ===\n');
  return true;
}

/**
 * Place or refresh quotes for a pair
 */
async function quotePair(
  ctx: EngineContext,
  base: TokenSymbol,
  quote: TokenSymbol
): Promise<{ bidPlaced: boolean; askPlaced: boolean }> {
  const key = pairKey(base, quote);
  const pairState = getPairState(ctx.state, base, quote);

  // Check cooldown
  const lastQuote = ctx.lastQuoteTime.get(key) || 0;
  const elapsed = Date.now() - lastQuote;
  if (elapsed < config.COOLDOWN_MS) {
    const remaining = Math.ceil((config.COOLDOWN_MS - elapsed) / 1000);
    logger.debug('engine', {
      message: `${key} in cooldown, ${remaining}s remaining`,
    });
    return { bidPlaced: false, askPlaced: false };
  }

  // Check TX budget
  const budget = checkTxBudget(ctx.state);
  if (!budget.allowed) {
    logger.warn('engine', {
      message: 'TX budget exhausted',
      dailyRemaining: budget.dailyRemaining,
    });
    return { bidPlaced: false, askPlaced: false };
  }

  // Get quote params
  const params = await getQuoteParams(base, quote);
  logger.debug('engine', {
    message: `Quote params for ${key}`,
    params: formatQuoteParams(params),
  });

  // Note: Tempo DEX doesn't require explicit deposits
  // Orders are placed directly from wallet with approval
  // Flip order proceeds automatically go to internal balance

  let bidPlaced = false;
  let askPlaced = false;

  // Place bid if needed
  if (!pairState.bidOrderId) {
    logger.info('engine', {
      message: `Placing bid for ${key}`,
      tick: params.bidTick,
      flipTick: params.bidFlipTick,
    });

    const budgetCheck = incrementTxCounter(ctx.state, false);
    if (!budgetCheck.allowed) {
      logger.warn('engine', { message: 'TX budget exhausted for bid' });
    } else {
      try {
        // Add jitter
        await sleep(Math.random() * config.JITTER_MS);

        const result = await placeFlipOrder({
          baseToken: base,
          amount: params.orderSize,
          isBid: true,
          tick: params.bidTick,
          flipTick: params.bidFlipTick,
        });

        if (result) {
          bidPlaced = true;
          updatePairOrders(ctx.state, base, quote, {
            bidOrderId: orderIdToString(result.orderId),
            lastBidTick: params.bidTick,
            lastBidFlipTick: params.bidFlipTick,
          });

          logger.txSuccess({
            reason: 'placeFlip',
            txHash: result.txHash,
            pair: key,
            side: 'bid',
            tick: params.bidTick,
            orderId: orderIdToString(result.orderId),
          });
        }
      } catch (error) {
        logger.txFailed({
          reason: 'placeFlip',
          pair: key,
          side: 'bid',
          error: error instanceof Error ? error.message : 'Unknown',
        });
      }
    }
  } else {
    logger.debug('engine', {
      message: `Bid already placed for ${key}`,
      orderId: pairState.bidOrderId,
    });
  }

  // Place ask if needed
  if (!pairState.askOrderId) {
    logger.info('engine', {
      message: `Placing ask for ${key}`,
      tick: params.askTick,
      flipTick: params.askFlipTick,
    });

    const budgetCheck = incrementTxCounter(ctx.state, false);
    if (!budgetCheck.allowed) {
      logger.warn('engine', { message: 'TX budget exhausted for ask' });
    } else {
      try {
        // Add jitter
        await sleep(Math.random() * config.JITTER_MS);

        const result = await placeFlipOrder({
          baseToken: base,
          amount: params.orderSize,
          isBid: false,
          tick: params.askTick,
          flipTick: params.askFlipTick,
        });

        if (result) {
          askPlaced = true;
          updatePairOrders(ctx.state, base, quote, {
            askOrderId: orderIdToString(result.orderId),
            lastAskTick: params.askTick,
            lastAskFlipTick: params.askFlipTick,
          });

          logger.txSuccess({
            reason: 'placeFlip',
            txHash: result.txHash,
            pair: key,
            side: 'ask',
            tick: params.askTick,
            orderId: orderIdToString(result.orderId),
          });
        }
      } catch (error) {
        logger.txFailed({
          reason: 'placeFlip',
          pair: key,
          side: 'ask',
          error: error instanceof Error ? error.message : 'Unknown',
        });
      }
    }
  } else {
    logger.debug('engine', {
      message: `Ask already placed for ${key}`,
      orderId: pairState.askOrderId,
    });
  }

  // Update last quote time
  ctx.lastQuoteTime.set(key, Date.now());

  return { bidPlaced, askPlaced };
}

/**
 * Check order status and detect fills
 */
async function checkOrderStatus(
  ctx: EngineContext,
  base: TokenSymbol,
  quote: TokenSymbol
): Promise<{
  bidFilled: boolean;
  askFilled: boolean;
  bidFlipOk: boolean;
  askFlipOk: boolean;
}> {
  const pairState = getPairState(ctx.state, base, quote);
  const key = pairKey(base, quote);

  let bidFilled = false;
  let askFilled = false;
  let bidFlipOk = true;
  let askFlipOk = true;

  // Check bid order
  if (pairState.bidOrderId) {
    try {
      const order = await getOrder(BigInt(pairState.bidOrderId));
      if (!order || order.remainingAmount === 0n) {
        bidFilled = true;
        logger.info('engine', {
          message: `Bid order filled`,
          orderId: pairState.bidOrderId,
          pair: key,
        });

        // Check if flip happened (look for new ask at flipTick)
        if (order?.isFlip && pairState.lastBidFlipTick !== null) {
          const flippedOrders = await getMakerOrders(base);
          const flippedAsk = flippedOrders.find(
            o => !o.isBid && o.tick === pairState.lastBidFlipTick
          );

          if (flippedAsk) {
            logger.info('engine', {
              message: `Bid flipped to ask successfully`,
              newOrderId: orderIdToString(flippedAsk.orderId),
              tick: flippedAsk.tick,
            });
            updatePairOrders(ctx.state, base, quote, {
              askOrderId: orderIdToString(flippedAsk.orderId),
              lastAskTick: flippedAsk.tick,
              lastAskFlipTick: flippedAsk.flipTick,
            });
          } else {
            bidFlipOk = false;
            logger.warn('engine', {
              message: `Bid flip failed - no ask found at flipTick`,
              expectedTick: pairState.lastBidFlipTick,
            });
          }
        }

        // Clear old bid order ID
        updatePairOrders(ctx.state, base, quote, { bidOrderId: null });
      }
    } catch (error) {
      logger.warn('engine', {
        message: `Error checking bid order`,
        orderId: pairState.bidOrderId,
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  // Check ask order
  if (pairState.askOrderId) {
    try {
      const order = await getOrder(BigInt(pairState.askOrderId));
      if (!order || order.remainingAmount === 0n) {
        askFilled = true;
        logger.info('engine', {
          message: `Ask order filled`,
          orderId: pairState.askOrderId,
          pair: key,
        });

        // Check if flip happened (look for new bid at flipTick)
        if (order?.isFlip && pairState.lastAskFlipTick !== null) {
          const flippedOrders = await getMakerOrders(base);
          const flippedBid = flippedOrders.find(
            o => o.isBid && o.tick === pairState.lastAskFlipTick
          );

          if (flippedBid) {
            logger.info('engine', {
              message: `Ask flipped to bid successfully`,
              newOrderId: orderIdToString(flippedBid.orderId),
              tick: flippedBid.tick,
            });
            updatePairOrders(ctx.state, base, quote, {
              bidOrderId: orderIdToString(flippedBid.orderId),
              lastBidTick: flippedBid.tick,
              lastBidFlipTick: flippedBid.flipTick,
            });
          } else {
            askFlipOk = false;
            logger.warn('engine', {
              message: `Ask flip failed - no bid found at flipTick`,
              expectedTick: pairState.lastAskFlipTick,
            });
          }
        }

        // Clear old ask order ID
        updatePairOrders(ctx.state, base, quote, { askOrderId: null });
      }
    } catch (error) {
      logger.warn('engine', {
        message: `Error checking ask order`,
        orderId: pairState.askOrderId,
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  return { bidFilled, askFilled, bidFlipOk, askFlipOk };
}

/**
 * Handle flip failure - diagnose and log
 * Note: Tempo DEX doesn't have deposit functionality, so recovery is not possible.
 * The flip will succeed on the next fill when internal balance is available.
 */
async function handleFlipFailure(
  ctx: EngineContext,
  base: TokenSymbol,
  quote: TokenSymbol,
  side: 'bid' | 'ask'
): Promise<void> {
  const key = pairKey(base, quote);

  // Diagnose the issue by checking inventory with buffer
  const inventory = await getInventoryState(base, quote);
  const params = await getQuoteParams(base, quote);
  const flipCheck = hasFlipBuffer(inventory, params.orderSize);

  let failReason = 'unknown';

  // Check if internal balance is insufficient for flip (includes MIN_INTERNAL_BUFFER)
  if (side === 'bid' && !flipCheck.quoteOk) {
    failReason = 'insufficientInternal_quote';
    logger.warn('engine', {
      message: `Flip failed: insufficient ${quote} internal balance (includes buffer)`,
      have: inventory.quoteDex.toString(),
      missing: flipCheck.quoteMissing.toString(),
    });
  } else if (side === 'ask' && !flipCheck.baseOk) {
    failReason = 'insufficientInternal_base';
    logger.warn('engine', {
      message: `Flip failed: insufficient ${base} internal balance (includes buffer)`,
      have: inventory.baseDex.toString(),
      missing: flipCheck.baseMissing.toString(),
    });
  }

  logger.txFailed({
    reason: 'flipFailed',
    pair: key,
    side,
    error: failReason,
  });

  // Note: Tempo DEX pulls directly from wallet with approval.
  // Flip orders use internal balance which accumulates from fills.
  // No manual deposit/recovery possible - flip will work once balance builds up.
  logger.info('engine', {
    message: 'Flip recovery not possible - Tempo DEX has no deposit function. Will retry on next cycle.',
    pair: key,
    side,
  });
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main engine loop
 */
async function runLoop(ctx: EngineContext): Promise<void> {
  ctx.status = 'RUNNING';
  const enabledPairs = config.pairs.filter(p => p.enabled);

  logger.text('info', '\n=== ENGINE RUNNING ===\n');
  logger.text('info', `Enabled pairs: ${enabledPairs.map(p => pairKey(p.base, p.quote)).join(', ')}`);
  logger.text('info', `Cooldown: ${config.COOLDOWN_MS / 1000}s`);
  logger.text('info', `TX budget: ${config.MAX_TX_PER_DAY}/day\n`);

  while (!ctx.stopRequested) {
    for (const pair of enabledPairs) {
      if (ctx.stopRequested) break;

      const key = pairKey(pair.base, pair.quote);

      try {
        // 1. Check order status and detect fills
        const status = await checkOrderStatus(ctx, pair.base, pair.quote);

        // 2. Handle flip failures
        if (status.bidFilled && !status.bidFlipOk) {
          await handleFlipFailure(ctx, pair.base, pair.quote, 'bid');
        }
        if (status.askFilled && !status.askFlipOk) {
          await handleFlipFailure(ctx, pair.base, pair.quote, 'ask');
        }

        // 3. Place/refresh quotes if needed
        await quotePair(ctx, pair.base, pair.quote);

      } catch (error) {
        logger.error('engine', {
          message: `Error processing ${key}`,
          error: error instanceof Error ? error.message : 'Unknown',
        });
      }
    }

    // Check budget status
    const budget = checkTxBudget(ctx.state);
    if (!budget.allowed) {
      ctx.status = 'COOLDOWN';
      logger.warn('engine', {
        message: 'TX budget exhausted, entering long cooldown',
        dailyRemaining: budget.dailyRemaining,
      });
      // Wait longer when budget exhausted
      await sleep(60 * 60 * 1000); // 1 hour
      ctx.status = 'RUNNING';
    } else {
      // Normal loop delay
      await sleep(10000); // 10 seconds
    }
  }

  ctx.status = 'STOPPED';
  logger.text('info', '\n=== ENGINE STOPPED ===\n');
}

/**
 * Start the engine
 */
export async function startEngine(): Promise<void> {
  logger.text('info', '\n🚀 Starting Tempo Market Maker Engine...\n');

  const ctx = createContext();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    logger.text('info', '\nReceived SIGINT, shutting down...');
    ctx.stopRequested = true;
  });

  process.on('SIGTERM', () => {
    logger.text('info', '\nReceived SIGTERM, shutting down...');
    ctx.stopRequested = true;
  });

  // Bootstrap
  const bootstrapOk = await bootstrap(ctx);
  if (!bootstrapOk) {
    logger.error('engine', { message: 'Bootstrap failed, exiting' });
    process.exit(1);
  }

  // Show current state
  logger.text('info', '\nCurrent state:');
  logger.text('info', formatState(ctx.state));

  // Run main loop
  await runLoop(ctx);

  // Save final state
  saveState(ctx.state);
  logger.text('info', 'Final state saved.');
}

/**
 * Run a single quote cycle (for testing)
 */
export async function runSingleCycle(): Promise<void> {
  logger.text('info', '\n🔄 Running single quote cycle...\n');

  const ctx = createContext();

  // Bootstrap
  const bootstrapOk = await bootstrap(ctx);
  if (!bootstrapOk) {
    logger.error('engine', { message: 'Bootstrap failed' });
    return;
  }

  const enabledPairs = config.pairs.filter(p => p.enabled);

  for (const pair of enabledPairs) {
    const key = pairKey(pair.base, pair.quote);
    logger.text('info', `\nQuoting ${key}...`);

    try {
      const result = await quotePair(ctx, pair.base, pair.quote);
      logger.text('info', `  Bid placed: ${result.bidPlaced}`);
      logger.text('info', `  Ask placed: ${result.askPlaced}`);
    } catch (error) {
      logger.error('engine', {
        message: `Failed to quote ${key}`,
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  // Save state
  saveState(ctx.state);
  logger.text('info', '\n✅ Single cycle complete.\n');
  logger.text('info', formatState(ctx.state));
}
