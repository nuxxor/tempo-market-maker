/**
 * DEX utilities for Tempo Stablecoin DEX
 *
 * Handles:
 * - Order placement (limit, flip)
 * - Order cancellation
 * - Order queries
 * - Internal balance management
 *
 * Uses viem/tempo extension actions for proper contract interaction
 */

import { type Address, type Hash, ContractFunctionExecutionError } from 'viem';
import { getTempoClient, getPublicClientHttp, getMakerAddress } from './client.js';
import { type TokenSymbol } from './config.js';
import { type OrderInfo, type OrderSide, orderIdToString } from './types.js';
import { logger } from './logger.js';
import { getTokenAddress } from './tokens.js';

/**
 * Get DEX internal balance for a token
 */
export async function getDexBalance(token: TokenSymbol): Promise<bigint> {
  const client = getTempoClient();
  const tokenAddress = getTokenAddress(token);
  const makerAddress = getMakerAddress();

  try {
    const balance = await client.dex.getBalance({
      account: makerAddress,
      token: tokenAddress,
    });
    return balance;
  } catch (error) {
    logger.warn('preflight', {
      message: `Failed to get DEX balance for ${token}`,
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return 0n;
  }
}

/**
 * Get order info by ID
 * Returns null if order doesn't exist (filled/cancelled)
 * Throws on RPC/network errors (caller should handle)
 */
export async function getOrder(orderId: bigint): Promise<OrderInfo | null> {
  const client = getTempoClient();

  try {
    const order = await client.dex.getOrder({
      orderId,
    });

    // Check if order exists (maker address is zero for non-existent orders)
    if (!order || order.maker === '0x0000000000000000000000000000000000000000') {
      return null;
    }

    return {
      orderId,
      maker: order.maker,
      baseToken: order.bookKey as Address, // bookKey represents the base token
      quoteToken: '0x20c0000000000000000000000000000000000000' as Address, // pathUSD
      isBid: order.isBid,
      isFlip: order.isFlip,
      tick: Number(order.tick),
      flipTick: order.isFlip ? Number(order.flipTick) : null,
      amount: order.amount,
      remainingAmount: order.remaining,
      status: order.remaining === 0n ? 'filled' : 'open',
    };
  } catch (error) {
    // Check for OrderDoesNotExist contract revert (order was filled/cancelled)
    if (error instanceof ContractFunctionExecutionError) {
      const cause = error.cause as { data?: { errorName?: string }; details?: string } | undefined;

      // Primary: use viem's parsed errorName
      if (cause?.data?.errorName === 'OrderDoesNotExist') {
        return null;
      }

      // Fallback: check details/message for RPCs that don't parse errorName
      const errorMsg = error.message || cause?.details || '';
      if (errorMsg.includes('OrderDoesNotExist')) {
        return null;
      }
    }

    // Re-throw actual RPC/network errors
    throw error;
  }
}

/**
 * Place a flip order using tempo actions
 * type: 'buy' = bid (buying base token with quote)
 * type: 'sell' = ask (selling base token for quote)
 */
export async function placeFlipOrder(params: {
  baseToken: TokenSymbol;
  amount: bigint;
  isBid: boolean;
  tick: number;
  flipTick: number;
}): Promise<{ orderId: bigint; txHash: Hash } | null> {
  const client = getTempoClient();
  const baseAddress = getTokenAddress(params.baseToken);
  const side: OrderSide = params.isBid ? 'bid' : 'ask';
  const pair = `${params.baseToken}/pathUSD`;

  // Convert isBid to type: 'buy' (bid) or 'sell' (ask)
  const orderType = params.isBid ? 'buy' : 'sell';

  logger.info('bootstrap', {
    pair,
    side,
    tick: params.tick,
    flipTick: params.flipTick,
    message: 'Placing flip order...',
  });

  try {
    // Use placeFlipSync to get the result with orderId
    const result = await client.dex.placeFlipSync({
      token: baseAddress,
      amount: params.amount,
      type: orderType,
      tick: params.tick,
      flipTick: params.flipTick,
    });

    const txHash = result.transactionHash;
    const orderId = result.orderId || 0n;

    logger.txSuccess({
      reason: 'bootstrap',
      pair,
      side,
      tick: params.tick,
      flipTick: params.flipTick,
      orderId: orderIdToString(orderId),
      txHash,
      gasUsed: result.gasUsed,
    });

    return { orderId, txHash };
  } catch (error) {
    logger.txFailed({
      reason: 'bootstrap',
      pair,
      side,
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return null;
  }
}

/**
 * Place a regular limit order (fallback if flip not needed)
 */
export async function placeOrder(params: {
  baseToken: TokenSymbol;
  amount: bigint;
  isBid: boolean;
  tick: number;
}): Promise<{ orderId: bigint; txHash: Hash } | null> {
  const client = getTempoClient();
  const baseAddress = getTokenAddress(params.baseToken);
  const side: OrderSide = params.isBid ? 'bid' : 'ask';
  const pair = `${params.baseToken}/pathUSD`;

  // Convert isBid to type: 'buy' (bid) or 'sell' (ask)
  const orderType = params.isBid ? 'buy' : 'sell';

  logger.info('bootstrap', {
    pair,
    side,
    tick: params.tick,
    message: 'Placing limit order...',
  });

  try {
    const result = await client.dex.placeSync({
      token: baseAddress,
      amount: params.amount,
      type: orderType,
      tick: params.tick,
    });

    const txHash = result.transactionHash;
    const orderId = result.orderId || 0n;

    logger.txSuccess({
      reason: 'bootstrap',
      pair,
      side,
      tick: params.tick,
      orderId: orderIdToString(orderId),
      txHash,
      gasUsed: result.gasUsed,
    });

    return { orderId, txHash };
  } catch (error) {
    logger.txFailed({
      reason: 'bootstrap',
      pair,
      side,
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return null;
  }
}

/**
 * Cancel an order
 */
export async function cancelOrder(orderId: bigint): Promise<{ txHash: Hash; success: boolean }> {
  const client = getTempoClient();

  logger.info('bootstrap', {
    orderId: orderIdToString(orderId),
    message: 'Cancelling order...',
  });

  try {
    const result = await client.dex.cancelSync({
      orderId,
    });

    logger.txSuccess({
      reason: 'bootstrap',
      orderId: orderIdToString(orderId),
      txHash: result.transactionHash,
      gasUsed: result.gasUsed,
    });

    return { txHash: result.transactionHash, success: true };
  } catch (error) {
    logger.txFailed({
      reason: 'bootstrap',
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return { txHash: '0x' as Hash, success: false };
  }
}

/**
 * Withdraw from DEX internal balance to wallet
 */
export async function withdrawFromDex(
  tokenAddress: Address,
  amount: bigint
): Promise<{ txHash: Hash; success: boolean }> {
  const client = getTempoClient();

  logger.info('withdraw', {
    message: `Withdrawing ${amount} from DEX...`,
  });

  try {
    const result = await client.dex.withdrawSync({
      token: tokenAddress,
      amount,
    });

    logger.txSuccess({
      reason: 'withdraw',
      txHash: result.transactionHash,
      gasUsed: result.gasUsed,
    });

    return { txHash: result.transactionHash, success: true };
  } catch (error) {
    logger.txFailed({
      reason: 'withdraw',
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return { txHash: '0x' as Hash, success: false };
  }
}

/**
 * Deposit to DEX internal balance
 * Note: Tempo DEX doesn't have a deposit function - orders are placed directly from wallet
 * This function is a no-op for compatibility with the engine
 */
export async function depositToDex(
  _token: TokenSymbol,
  _amount: bigint
): Promise<{ txHash: Hash; success: boolean }> {
  // Tempo DEX doesn't require explicit deposits
  // Orders are placed directly from the wallet with prior approval
  logger.debug('bootstrap', {
    message: 'Deposit not needed - Tempo DEX uses direct wallet transfers',
  });
  return { txHash: '0x' as Hash, success: true };
}

/**
 * Check if a trading pair exists
 */
export async function pairExists(baseToken: TokenSymbol): Promise<boolean> {
  const client = getTempoClient();
  const baseAddress = getTokenAddress(baseToken);

  try {
    // Try to get tick level at 0 - if it returns without error, pair exists
    await client.dex.getTickLevel({
      base: baseAddress,
      tick: 0,
      isBid: true,
    });
    return true;
  } catch {
    // Pair doesn't exist
    return false;
  }
}

/**
 * Create a trading pair (idempotent wrapper)
 */
export async function ensurePairExists(baseToken: TokenSymbol): Promise<boolean> {
  // First check if pair exists
  const exists = await pairExists(baseToken);
  if (exists) {
    logger.debug('preflight', {
      message: `Pair ${baseToken}/pathUSD already exists`,
    });
    return true;
  }

  // Try to create pair
  const client = getTempoClient();
  const baseAddress = getTokenAddress(baseToken);

  logger.info('preflight', {
    message: `Creating pair ${baseToken}/pathUSD...`,
  });

  try {
    const result = await client.dex.createPairSync({
      base: baseAddress,
    });

    logger.info('preflight', {
      message: `Pair ${baseToken}/pathUSD created`,
      txHash: result.transactionHash,
    });
    return true;
  } catch (error) {
    // Pair might already exist (createPair reverts if exists)
    const errorMsg = error instanceof Error ? error.message : '';
    if (errorMsg.includes('already exists') || errorMsg.includes('revert')) {
      logger.debug('preflight', {
        message: `Pair ${baseToken}/pathUSD already exists (caught revert)`,
      });
      return true;
    }
    logger.warn('preflight', {
      message: `Failed to create pair ${baseToken}/pathUSD`,
      error: errorMsg,
    });
  }

  return false;
}

/**
 * Get all open orders for maker via RPC
 * Uses dex_getOrders if available
 */
export async function getMakerOrders(baseToken?: TokenSymbol): Promise<OrderInfo[]> {
  const client = getPublicClientHttp();
  const makerAddress = getMakerAddress();

  try {
    // Try Tempo-specific RPC method
    const result = await client.request({
      method: 'dex_getOrders',
      params: [
        {
          maker: makerAddress,
          baseToken: baseToken ? getTokenAddress(baseToken) : undefined,
        } as unknown,
      ],
    } as any);

    // Parse result into OrderInfo array
    if (Array.isArray(result)) {
      return result.map((order: any) => ({
        orderId: BigInt(order.orderId),
        maker: order.maker,
        baseToken: order.baseToken || order.bookKey,
        quoteToken: order.quoteToken || '0x20c0000000000000000000000000000000000000',
        isBid: order.isBid,
        isFlip: order.isFlip,
        tick: Number(order.tick),
        flipTick: order.isFlip ? Number(order.flipTick) : null,
        amount: BigInt(order.amount),
        remainingAmount: BigInt(order.remaining),
        status: BigInt(order.remaining) === 0n ? 'filled' : 'open',
      }));
    }
  } catch {
    // RPC method not available
    logger.debug('preflight', {
      message: 'dex_getOrders RPC method not available',
    });
  }

  return [];
}
