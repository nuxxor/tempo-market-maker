/**
 * Strategy - Quote ticks and inventory-aware spread calculation
 *
 * Handles:
 * - Mid price calculation (stablecoin peg assumption: mid = 0)
 * - Bid/ask tick calculation based on spread
 * - Inventory-aware spread adjustment (future)
 * - Rebalance decision logic
 */

import { type Address } from 'viem';
import { config, type TokenSymbol } from './config.js';
import { calculateQuoteTicks, bpsToTicks, roundToSpacing, assertFlipConstraints } from './ticks.js';
import { getDexBalance } from './dex.js';
import { getWalletBalance, getDecimals, getTokenAddress, formatBalance } from './tokens.js';
import { logger } from './logger.js';

/**
 * Pair quote parameters - everything needed to place orders
 */
export interface QuoteParams {
  baseToken: TokenSymbol;
  quoteToken: TokenSymbol;
  bidTick: number;
  askTick: number;
  bidFlipTick: number;
  askFlipTick: number;
  orderSize: bigint;
  decimals: number;
}

/**
 * Inventory state for a pair
 */
export interface InventoryState {
  baseToken: TokenSymbol;
  quoteToken: TokenSymbol;
  baseWallet: bigint;
  baseDex: bigint;
  quoteWallet: bigint;
  quoteDex: bigint;
  baseDecimals: number;
  quoteDecimals: number;
}

/**
 * Rebalance recommendation
 */
export interface RebalanceAction {
  needed: boolean;
  reason?: string;
  action?: 'deposit_base' | 'deposit_quote' | 'withdraw_base' | 'withdraw_quote';
  amount?: bigint;
}

/**
 * Get quote parameters for a pair
 * Uses stablecoin peg assumption (mid = 0)
 */
export async function getQuoteParams(
  baseToken: TokenSymbol,
  quoteToken: TokenSymbol = 'pathUSD'
): Promise<QuoteParams> {
  const { bidTick, askTick, halfSpreadTicks } = calculateQuoteTicks();

  // Flip ticks: bid fills → becomes ask at askTick, ask fills → becomes bid at bidTick
  // Constraints: bid flipTick > tick, ask flipTick < tick
  const bidFlipTick = askTick; // When bid fills, flip to ask
  const askFlipTick = bidTick; // When ask fills, flip to bid

  // Validate flip constraints
  assertFlipConstraints(true, bidTick, bidFlipTick);  // Bid: flipTick > tick
  assertFlipConstraints(false, askTick, askFlipTick); // Ask: flipTick < tick

  // Get decimals for order size calculation
  const baseAddress = getTokenAddress(baseToken);
  const decimals = await getDecimals(baseAddress);

  // Parse order size from human-readable config
  const orderSize = BigInt(Math.floor(parseFloat(config.ORDER_SIZE_HUMAN) * (10 ** decimals)));

  return {
    baseToken,
    quoteToken,
    bidTick,
    askTick,
    bidFlipTick,
    askFlipTick,
    orderSize,
    decimals,
  };
}

/**
 * Get current inventory state for a pair
 */
export async function getInventoryState(
  baseToken: TokenSymbol,
  quoteToken: TokenSymbol = 'pathUSD'
): Promise<InventoryState> {
  const baseAddress = getTokenAddress(baseToken);
  const quoteAddress = getTokenAddress(quoteToken);

  // Fetch all balances in parallel
  const [
    baseWallet,
    baseDex,
    quoteWallet,
    quoteDex,
    baseDecimals,
    quoteDecimals,
  ] = await Promise.all([
    getWalletBalance(baseAddress),
    getDexBalance(baseToken),
    getWalletBalance(quoteAddress),
    getDexBalance(quoteToken),
    getDecimals(baseAddress),
    getDecimals(quoteAddress),
  ]);

  return {
    baseToken,
    quoteToken,
    baseWallet,
    baseDex,
    quoteWallet,
    quoteDex,
    baseDecimals,
    quoteDecimals,
  };
}

/**
 * Check if internal balance is sufficient for flip orders
 *
 * Flip orders ONLY use DEX internal balance for escrow.
 * If internal balance is insufficient, flip silently fails!
 */
export function hasFlipBuffer(inventory: InventoryState, orderSize: bigint): {
  baseOk: boolean;
  quoteOk: boolean;
  baseMissing: bigint;
  quoteMissing: bigint;
} {
  // Parse minimum buffer from config
  const minBuffer = BigInt(
    Math.floor(parseFloat(config.MIN_INTERNAL_BUFFER_HUMAN) * (10 ** inventory.baseDecimals))
  );

  // For flip orders, we need internal balance >= order size + buffer
  const requiredBase = orderSize + minBuffer;
  const requiredQuote = orderSize + minBuffer;

  const baseOk = inventory.baseDex >= requiredBase;
  const quoteOk = inventory.quoteDex >= requiredQuote;

  return {
    baseOk,
    quoteOk,
    baseMissing: baseOk ? 0n : requiredBase - inventory.baseDex,
    quoteMissing: quoteOk ? 0n : requiredQuote - inventory.quoteDex,
  };
}

/**
 * Check if rebalance is needed
 *
 * Scenarios:
 * 1. Internal balance too low for flip orders
 * 2. Inventory drift (too much on one side)
 */
export async function checkRebalance(
  baseToken: TokenSymbol,
  quoteToken: TokenSymbol = 'pathUSD'
): Promise<RebalanceAction> {
  const inventory = await getInventoryState(baseToken, quoteToken);
  const params = await getQuoteParams(baseToken, quoteToken);
  const flipCheck = hasFlipBuffer(inventory, params.orderSize);

  // Priority 1: Internal balance too low for flip
  if (!flipCheck.baseOk) {
    // Check if wallet has enough to deposit
    if (inventory.baseWallet >= flipCheck.baseMissing) {
      return {
        needed: true,
        reason: `${baseToken} internal balance too low for flip orders`,
        action: 'deposit_base',
        amount: flipCheck.baseMissing,
      };
    } else {
      logger.warn('strategy', {
        message: `${baseToken} wallet balance also insufficient`,
        walletBalance: formatBalance(inventory.baseWallet, inventory.baseDecimals),
        needed: formatBalance(flipCheck.baseMissing, inventory.baseDecimals),
      });
    }
  }

  if (!flipCheck.quoteOk) {
    // Check if wallet has enough to deposit
    if (inventory.quoteWallet >= flipCheck.quoteMissing) {
      return {
        needed: true,
        reason: `${quoteToken} internal balance too low for flip orders`,
        action: 'deposit_quote',
        amount: flipCheck.quoteMissing,
      };
    } else {
      logger.warn('strategy', {
        message: `${quoteToken} wallet balance also insufficient`,
        walletBalance: formatBalance(inventory.quoteWallet, inventory.quoteDecimals),
        needed: formatBalance(flipCheck.quoteMissing, inventory.quoteDecimals),
      });
    }
  }

  // Priority 2: Inventory drift check (future enhancement)
  // For now, no rebalance needed if flip buffer is OK

  return { needed: false };
}

/**
 * Format quote params for logging
 */
export function formatQuoteParams(params: QuoteParams): string {
  const orderSizeHuman = formatBalance(params.orderSize, params.decimals);
  return [
    `Pair: ${params.baseToken}/${params.quoteToken}`,
    `Bid: tick=${params.bidTick}, flipTick=${params.bidFlipTick}`,
    `Ask: tick=${params.askTick}, flipTick=${params.askFlipTick}`,
    `Size: ${orderSizeHuman} ${params.baseToken}`,
  ].join('\n  ');
}

/**
 * Format inventory state for logging
 */
export function formatInventory(inventory: InventoryState): string {
  const baseWalletHuman = formatBalance(inventory.baseWallet, inventory.baseDecimals);
  const baseDexHuman = formatBalance(inventory.baseDex, inventory.baseDecimals);
  const quoteWalletHuman = formatBalance(inventory.quoteWallet, inventory.quoteDecimals);
  const quoteDexHuman = formatBalance(inventory.quoteDex, inventory.quoteDecimals);

  return [
    `${inventory.baseToken}:`,
    `  Wallet: ${baseWalletHuman}`,
    `  DEX: ${baseDexHuman}`,
    `${inventory.quoteToken}:`,
    `  Wallet: ${quoteWalletHuman}`,
    `  DEX: ${quoteDexHuman}`,
  ].join('\n');
}

/**
 * Validate that a pair can be quoted
 * Checks: sufficient balance, proper decimals, etc.
 */
export async function canQuotePair(
  baseToken: TokenSymbol,
  quoteToken: TokenSymbol = 'pathUSD'
): Promise<{ canQuote: boolean; reason?: string }> {
  try {
    const inventory = await getInventoryState(baseToken, quoteToken);
    const params = await getQuoteParams(baseToken, quoteToken);

    // Check total balance (wallet + DEX) for both tokens
    const totalBase = inventory.baseWallet + inventory.baseDex;
    const totalQuote = inventory.quoteWallet + inventory.quoteDex;

    if (totalBase < params.orderSize) {
      return {
        canQuote: false,
        reason: `Insufficient ${baseToken} balance (have ${formatBalance(totalBase, params.decimals)}, need ${config.ORDER_SIZE_HUMAN})`,
      };
    }

    if (totalQuote < params.orderSize) {
      const quoteDecimals = await getDecimals(getTokenAddress(quoteToken));
      return {
        canQuote: false,
        reason: `Insufficient ${quoteToken} balance (have ${formatBalance(totalQuote, quoteDecimals)}, need ${config.ORDER_SIZE_HUMAN})`,
      };
    }

    return { canQuote: true };
  } catch (error) {
    return {
      canQuote: false,
      reason: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
