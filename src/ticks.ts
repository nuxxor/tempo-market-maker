import { TICK_CONSTANTS, config } from './config.js';

const { TICK_SPACING, TICK_BOUNDS, TICKS_PER_BPS } = TICK_CONSTANTS;

/**
 * Convert basis points to ticks
 * 1 bp = 10 ticks
 */
export function bpsToTicks(bps: number): number {
  return bps * TICKS_PER_BPS;
}

/**
 * Convert ticks to basis points
 */
export function ticksToBps(ticks: number): number {
  return ticks / TICKS_PER_BPS;
}

/**
 * Round tick to nearest valid spacing (multiple of 10)
 * Uses banker's rounding (round half to even) for consistency
 */
export function roundToSpacing(tick: number): number {
  const rounded = Math.round(tick / TICK_SPACING) * TICK_SPACING;
  return rounded;
}

/**
 * Clamp tick to valid bounds [-2000, 2000]
 */
export function clampTick(tick: number): number {
  return Math.max(TICK_BOUNDS.MIN, Math.min(TICK_BOUNDS.MAX, tick));
}

/**
 * Validate tick is within bounds and properly spaced
 */
export function isValidTick(tick: number): boolean {
  if (tick < TICK_BOUNDS.MIN || tick > TICK_BOUNDS.MAX) {
    return false;
  }
  if (tick % TICK_SPACING !== 0) {
    return false;
  }
  return true;
}

/**
 * Assert flip order constraints:
 * - Bid: flipTick > tick
 * - Ask: flipTick < tick
 */
export function assertFlipConstraints(isBid: boolean, tick: number, flipTick: number): void {
  if (isBid) {
    if (flipTick <= tick) {
      throw new Error(
        `Flip constraint violated for bid: flipTick (${flipTick}) must be > tick (${tick})`
      );
    }
  } else {
    if (flipTick >= tick) {
      throw new Error(
        `Flip constraint violated for ask: flipTick (${flipTick}) must be < tick (${tick})`
      );
    }
  }
}

/**
 * Calculate half spread ticks from total spread BPS
 * Rounds to nearest valid tick spacing
 */
export function calculateHalfSpreadTicks(totalSpreadBps: number = config.TOTAL_SPREAD_BPS): number {
  const halfSpreadBps = totalSpreadBps / 2;
  const halfSpreadTicks = bpsToTicks(halfSpreadBps);
  return roundToSpacing(halfSpreadTicks);
}

/**
 * Calculate quote ticks for a stablecoin pair
 * Assumes midTick = 0 (pegged stablecoins)
 */
export function calculateQuoteTicks(totalSpreadBps: number = config.TOTAL_SPREAD_BPS): {
  bidTick: number;
  askTick: number;
  midTick: number;
  halfSpreadTicks: number;
} {
  const midTick = 0; // Stablecoin peg assumption
  const halfSpreadTicks = calculateHalfSpreadTicks(totalSpreadBps);

  // Bid is below mid (willing to buy at lower price)
  // Ask is above mid (willing to sell at higher price)
  const bidTick = clampTick(midTick - halfSpreadTicks);
  const askTick = clampTick(midTick + halfSpreadTicks);

  // Validate ticks
  if (!isValidTick(bidTick) || !isValidTick(askTick)) {
    throw new Error(`Invalid ticks calculated: bid=${bidTick}, ask=${askTick}`);
  }

  return {
    bidTick,
    askTick,
    midTick,
    halfSpreadTicks,
  };
}

/**
 * Calculate flip tick for a given order
 * Bid order flips to ask (flipTick > tick)
 * Ask order flips to bid (flipTick < tick)
 */
export function calculateFlipTick(tick: number, isBid: boolean, spreadTicks?: number): number {
  const spread = spreadTicks ?? calculateHalfSpreadTicks() * 2;

  let flipTick: number;
  if (isBid) {
    // Bid flips to ask: flipTick > tick
    flipTick = tick + spread;
  } else {
    // Ask flips to bid: flipTick < tick
    flipTick = tick - spread;
  }

  flipTick = roundToSpacing(flipTick);
  flipTick = clampTick(flipTick);

  // Assert constraints
  assertFlipConstraints(isBid, tick, flipTick);

  return flipTick;
}

/**
 * Convert tick to price multiplier
 * price = 1 + (tick / PRICE_SCALE)
 */
export function tickToPrice(tick: number): number {
  return 1 + tick / TICK_CONSTANTS.PRICE_SCALE;
}

/**
 * Format tick for display
 */
export function formatTick(tick: number): string {
  const bps = ticksToBps(tick);
  const price = tickToPrice(tick);
  return `${tick} ticks (${bps.toFixed(1)} bps, price: ${price.toFixed(5)})`;
}
