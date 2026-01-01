import { type Address } from 'viem';
import 'dotenv/config';

// Token addresses on Tempo Testnet (Andantino)
export const TOKENS = {
  pathUSD: '0x20c0000000000000000000000000000000000000' as Address,
  AlphaUSD: '0x20c0000000000000000000000000000000000001' as Address,
  BetaUSD: '0x20c0000000000000000000000000000000000002' as Address,
  ThetaUSD: '0x20c0000000000000000000000000000000000003' as Address,
} as const;

// DEX contract address
export const DEX_ADDRESS = '0xdec0000000000000000000000000000000000000' as Address;

// Tick system constants
export const TICK_CONSTANTS = {
  PRICE_SCALE: 100_000,      // 1 tick = 0.001% = 0.1 bp
  TICK_SPACING: 10,          // tick % 10 == 0 zorunlu
  TICK_BOUNDS: {
    MIN: -2000,              // -2%
    MAX: 2000,               // +2%
  },
  BPS_PER_TICK: 0.1,         // 1 tick = 0.1 basis point
  TICKS_PER_BPS: 10,         // 1 basis point = 10 ticks
} as const;

// Trading pair configuration
export interface PairConfig {
  base: keyof typeof TOKENS;
  quote: keyof typeof TOKENS;
  enabled: boolean;
}

export const config = {
  // Network
  rpc: process.env.RPC_URL || 'https://rpc.testnet.tempo.xyz',
  ws: process.env.WS_URL || 'wss://rpc.testnet.tempo.xyz',
  chainId: 42429,
  explorerUrl: 'https://explore.tempo.xyz',

  // DEX
  dexAddress: DEX_ADDRESS,

  // Strategy (TOTAL spread, half spread RUNTIME'da türetilir)
  // 10 bps total = 5 bps each side = 50 ticks each side
  TOTAL_SPREAD_BPS: 10,

  // Order size - HUMAN readable, runtime'da decimals ile parseUnits
  ORDER_SIZE_HUMAN: '100',            // 100 base token (string!)
  MIN_INTERNAL_BUFFER_HUMAN: '120',   // Flip için min internal balance

  // Budget (genuine, spam değil)
  MAX_TX_PER_DAY: 100,
  MAX_CANCELS_PER_HOUR: 10,
  COOLDOWN_MS: 60_000,                // Min 60 sn aynı pair için
  JITTER_MS: 5_000,                   // Fingerprint azaltma

  // Flip fail detection
  FLIP_TIMEOUT_MS: 10_000,            // 10 sn sonra chain verify

  // MVP: Tek pair ile başla (sonra multi-pair)
  pairs: [
    { base: 'AlphaUSD', quote: 'pathUSD', enabled: true },
    // { base: 'BetaUSD', quote: 'pathUSD', enabled: false },   // Phase 2
    // { base: 'ThetaUSD', quote: 'pathUSD', enabled: false },  // Phase 2
  ] as PairConfig[],

  // Fee token preference
  feeToken: (process.env.FEE_TOKEN as keyof typeof TOKENS) || 'AlphaUSD',
} as const;

// Validate config
export function validateConfig(): void {
  // TOTAL_SPREAD_BPS should ideally be even for symmetric spread
  if (config.TOTAL_SPREAD_BPS % 2 !== 0) {
    console.warn(
      `[CONFIG] TOTAL_SPREAD_BPS (${config.TOTAL_SPREAD_BPS}) is odd. ` +
      `Half spread will be rounded to nearest tick spacing.`
    );
  }

  // Check private key
  if (!process.env.PRIVATE_KEY) {
    throw new Error('[CONFIG] PRIVATE_KEY environment variable is required');
  }

  // Validate pairs
  const enabledPairs = config.pairs.filter(p => p.enabled);
  if (enabledPairs.length === 0) {
    throw new Error('[CONFIG] At least one pair must be enabled');
  }

  console.log('[CONFIG] Validation passed');
  console.log(`[CONFIG] Enabled pairs: ${enabledPairs.map(p => `${p.base}/${p.quote}`).join(', ')}`);
}

// Get private key (with 0x prefix)
export function getPrivateKey(): `0x${string}` {
  const key = process.env.PRIVATE_KEY;
  if (!key) {
    throw new Error('PRIVATE_KEY environment variable is required');
  }
  return key.startsWith('0x') ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`);
}

export type TokenSymbol = keyof typeof TOKENS;
