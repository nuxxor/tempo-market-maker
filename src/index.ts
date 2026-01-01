/**
 * Tempo Stablecoin DEX - Reference Market Maker Engine
 *
 * Main entry point for the market maker bot.
 *
 * Usage:
 *   npm run start        - Run full engine (continuous loop)
 *   npm run start:once   - Run single quote cycle (for testing)
 */

import 'dotenv/config';
import { initializeClients, getMakerAddress } from './client.js';
import { validateConfig, config } from './config.js';
import { logger } from './logger.js';
import { getAllBalances, getAllowance, getTokenAddress, formatBalance } from './tokens.js';
import { calculateQuoteTicks, formatTick } from './ticks.js';
import { startEngine, runSingleCycle } from './engine.js';

async function preflight(): Promise<boolean> {
  logger.text('info', 'Running preflight checks...\n');

  // 1. Validate config
  try {
    validateConfig();
  } catch (error) {
    logger.error('preflight', {
      message: 'Config validation failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }

  // 2. Initialize clients
  const { httpOk, wsOk, makerAddress } = await initializeClients();

  if (!httpOk) {
    logger.error('preflight', { message: 'HTTP RPC connection failed' });
    return false;
  }

  if (!wsOk) {
    logger.warn('preflight', { message: 'WebSocket connection failed, will use polling fallback' });
  }

  // 3. Check balances
  logger.text('info', '\nChecking balances...');
  const balances = await getAllBalances();

  let hasBalance = false;
  for (const balance of balances) {
    const formatted = formatBalance(balance.walletBalance, balance.decimals);
    if (balance.walletBalance > 0n) {
      hasBalance = true;
      logger.text('info', `  ✅ ${balance.symbol}: ${formatted}`);
    } else {
      logger.text('warn', `  ⚠️  ${balance.symbol}: 0`);
    }
  }

  if (!hasBalance) {
    logger.error('preflight', {
      message: 'No tokens found. Run `npm run fund` first.',
    });
    return false;
  }

  // 4. Check allowances for enabled pairs
  logger.text('info', '\nChecking allowances...');
  const enabledPairs = config.pairs.filter(p => p.enabled);

  let allApproved = true;
  for (const pair of enabledPairs) {
    const baseAddress = getTokenAddress(pair.base);
    const quoteAddress = getTokenAddress(pair.quote);

    const baseAllowance = await getAllowance(baseAddress);
    const quoteAllowance = await getAllowance(quoteAddress);

    const baseOk = baseAllowance > 0n;
    const quoteOk = quoteAllowance > 0n;

    if (baseOk && quoteOk) {
      logger.text('info', `  ✅ ${pair.base}/${pair.quote}: Approved`);
    } else {
      logger.text('warn', `  ⚠️  ${pair.base}/${pair.quote}: Run \`npm run approve\``);
      allApproved = false;
    }
  }

  // 5. Show strategy info
  logger.text('info', '\nStrategy configuration:');
  const { bidTick, askTick, halfSpreadTicks } = calculateQuoteTicks();
  logger.text('info', `  Total spread: ${config.TOTAL_SPREAD_BPS} bps`);
  logger.text('info', `  Half spread: ${halfSpreadTicks} ticks`);
  logger.text('info', `  Bid tick: ${formatTick(bidTick)}`);
  logger.text('info', `  Ask tick: ${formatTick(askTick)}`);
  logger.text('info', `  Order size: ${config.ORDER_SIZE_HUMAN} tokens`);

  return true;
}

async function main() {
  logger.banner();

  logger.text('info', `Maker: ${getMakerAddress()}`);
  logger.text('info', `Network: Tempo Testnet (Chain ID: ${config.chainId})`);
  logger.text('info', `RPC: ${config.rpc}\n`);

  // Run preflight
  const preflightOk = await preflight();

  if (!preflightOk) {
    logger.error('preflight', { message: 'Preflight checks failed. Exiting.' });
    process.exit(1);
  }

  logger.text('info', '\n✅ Preflight checks passed!\n');

  // Check for --once flag (single cycle mode)
  const singleCycle = process.argv.includes('--once');

  if (singleCycle) {
    logger.text('info', '='.repeat(60));
    logger.text('info', 'SINGLE CYCLE MODE');
    logger.text('info', '='.repeat(60));
    await runSingleCycle();
  } else {
    logger.text('info', '='.repeat(60));
    logger.text('info', 'CONTINUOUS MODE');
    logger.text('info', '='.repeat(60));
    await startEngine();
  }
}

main().catch((error) => {
  logger.error('engine', {
    message: 'Engine failed',
    error: error instanceof Error ? error.message : 'Unknown error',
  });
  process.exit(1);
});
