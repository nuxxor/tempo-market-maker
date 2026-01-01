import { type Address, type Hash } from 'viem';
import { type TokenSymbol } from './config.js';

// Order side
export type OrderSide = 'bid' | 'ask';

// Order status
export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'unknown';

// Token metadata from chain
export interface TokenMetadata {
  decimals: number;
  symbol: string;
  name: string;
  transferPolicyId: bigint;
  quoteToken: Address | null;
  currency: string | null;
}

// Token balance info
export interface TokenBalance {
  symbol: TokenSymbol;
  address: Address;
  walletBalance: bigint;
  dexBalance: bigint;
  decimals: number;
}

// Order info from DEX
export interface OrderInfo {
  orderId: bigint;
  maker: Address;
  baseToken: Address;
  quoteToken: Address;
  isBid: boolean;
  isFlip: boolean;
  tick: number;
  flipTick: number | null;
  amount: bigint;
  remainingAmount: bigint;
  status: OrderStatus;
}

// Pair state for state.json
export interface PairState {
  base: TokenSymbol;
  quote: TokenSymbol;
  bidOrderId: string | null;    // Decimal string format
  askOrderId: string | null;    // Decimal string format
  lastBidTick: number;
  lastAskTick: number;
}

// Persistent state schema
export interface EngineState {
  schemaVersion: number;
  makerAddress: Address;
  pairs: PairState[];
  lastProcessedBlock: number;
  txCounters: {
    daily: number;
    cancelsThisHour: number;
    lastDayReset: string;       // ISO timestamp
    lastHourReset: string;      // ISO timestamp
  };
}

// Log entry reasons
export type LogReason =
  | 'bootstrap'
  | 'allowance'
  | 'replaceQuotes'
  | 'flipFailed'
  | 'rebalance'
  | 'withdraw'
  | 'orderFilled'
  | 'orderCancelled'
  | 'flipPlaced'
  | 'preflight'
  | 'reconcile'
  | 'engine'
  | 'state'
  | 'strategy'
  | 'placeFlip'
  | 'flipRecovery';

// Flip fail reasons
export type FlipFailReason =
  | 'insufficientInternal'
  | 'policyUnauthorized'
  | 'timeout'
  | 'unknown';

// Structured log entry
export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  reason: LogReason;
  pair?: string;
  side?: OrderSide;
  tick?: number;
  flipTick?: number;
  orderId?: string;
  txHash?: Hash;
  gasUsed?: bigint;
  message?: string;
  error?: string;
  failReason?: FlipFailReason;
  // Allow additional context properties
  [key: string]: unknown;
}

// Engine state machine states
export type EnginePhase =
  | 'IDLE'
  | 'PREFLIGHT'
  | 'BOOTSTRAP'
  | 'RUNNING'
  | 'COOLDOWN'
  | 'ERROR';

// Quote placement result
export interface PlaceQuoteResult {
  success: boolean;
  orderId?: bigint;
  txHash?: Hash;
  error?: string;
}

// Policy authorization result
export interface PolicyCheckResult {
  authorized: boolean;
  basePolicyId: bigint;
  quotePolicyId: bigint;
  makerAuthorizedBase: boolean;
  makerAuthorizedQuote: boolean;
  dexAuthorizedBase: boolean;
  dexAuthorizedQuote: boolean;
}

// Inventory for rebalance decisions
export interface Inventory {
  [symbol: string]: {
    walletBalance: bigint;
    dexBalance: bigint;
    totalBalance: bigint;
    decimals: number;
  };
}

// Convert orderId to/from state format
export function orderIdToString(orderId: bigint): string {
  return orderId.toString();
}

export function stringToOrderId(str: string): bigint {
  return BigInt(str);
}

// Normalize orderId from hex (dex_getOrders returns hex)
export function normalizeOrderId(orderIdHex: string): string {
  return BigInt(orderIdHex).toString();
}
