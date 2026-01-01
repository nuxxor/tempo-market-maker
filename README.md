# Tempo Stablecoin DEX - Reference Market Maker Engine

A reference implementation of a market maker bot for the Tempo Stablecoin DEX on testnet.

## Overview

This project provides genuine utility for the Tempo ecosystem by:
- Providing two-sided liquidity on the stablecoin DEX
- Correctly implementing DEX semantics (tick grid, flip orders, internal balance)
- Event-driven architecture with restart recovery
- Open source reference for other developers

**This is NOT a "TX spam bot"** - it's a properly engineered market maker that follows protocol specifications.

## Network Info

| Property | Value |
|----------|-------|
| Network | Tempo Testnet (Andantino) |
| Chain ID | 42429 |
| RPC | https://rpc.testnet.tempo.xyz |
| WebSocket | wss://rpc.testnet.tempo.xyz |
| Explorer | https://explore.tempo.xyz |

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env and add your private key
```

### 3. Get Testnet Tokens

```bash
npm run fund
```

Or manually visit: https://docs.tempo.xyz/quickstart/faucet

### 4. Check Balances

```bash
npm run balances
```

### 5. Approve DEX Spending

```bash
npm run approve
```

### 6. Run the Bot

```bash
npm run start
```

## Project Structure

```
tempo/
├── src/
│   ├── index.ts      # Entry point
│   ├── config.ts     # Network, tokens, strategy config
│   ├── client.ts     # Viem client setup (HTTP + WS)
│   ├── tokens.ts     # TIP-20 balance/allowance/approve
│   ├── dex.ts        # DEX order placement/cancellation
│   ├── strategy.ts   # Quote ticks and spread calculation
│   ├── state.ts      # State persistence (JSON)
│   ├── engine.ts     # Main bot loop and orchestration
│   ├── ticks.ts      # Tick calculation utilities
│   ├── logger.ts     # Structured logging
│   └── types.ts      # TypeScript types
├── scripts/
│   ├── fund.ts       # Get testnet tokens
│   ├── balances.ts   # Check balances
│   └── approve.ts    # Approve DEX spending
└── state.json        # Persistent state (gitignored)
```

## Key Concepts

### Tick System

- PRICE_SCALE = 100,000 (1 tick = 0.001% = 0.1 bp)
- Tick spacing = 10 (tick % 10 == 0)
- Tick bounds = ±2000 (±2%)
- 1 basis point = 10 ticks

### Flip Orders

Flip orders automatically switch sides when filled:
- Bid order fills → becomes ask at flipTick
- Ask order fills → becomes bid at flipTick

Constraints:
- Bid: `flipTick > tick`
- Ask: `flipTick < tick`

### DEX Internal Balance

- Order fill proceeds go to DEX internal balance
- Flip orders use internal balance for escrow
- If internal balance insufficient, flip silently fails
- Use `npm run balances` to check both wallet and DEX balances

## Configuration

Edit `src/config.ts` to adjust:

```typescript
// Strategy
TOTAL_SPREAD_BPS: 10,        // 0.1% total spread
ORDER_SIZE_HUMAN: '100',     // 100 tokens per order

// Budget
MAX_TX_PER_DAY: 100,
MAX_CANCELS_PER_HOUR: 10,

// Pairs (MVP: single pair)
pairs: [
  { base: 'AlphaUSD', quote: 'pathUSD', enabled: true },
]
```

## Development Phases

### Phase 1: Foundation ✅
- [x] Project setup
- [x] Client configuration
- [x] Token utilities
- [x] Tick calculations
- [x] Preflight scripts

### Phase 2: Order Management ✅
- [x] DEX order placement (placeFlipOrder, placeOrder)
- [x] Flip order semantics
- [x] Two-sided quoting (bid + ask flip orders)
- [x] Order cancellation

### Phase 3: Event-Driven Engine ✅
- [x] State persistence (state.json)
- [x] Restart recovery (reconcileOrders)
- [x] Flip fail detection and handling
- [x] TX budget enforcement
- [x] Main engine loop

### Phase 4: Multi-Pair (TODO)
- [ ] Additional pairs (BetaUSD, ThetaUSD)
- [ ] Inventory rebalancing

## Token Addresses

| Token | Address |
|-------|---------|
| pathUSD | `0x20c0000000000000000000000000000000000000` |
| AlphaUSD | `0x20c0000000000000000000000000000000000001` |
| BetaUSD | `0x20c0000000000000000000000000000000000002` |
| ThetaUSD | `0x20c0000000000000000000000000000000000003` |

DEX Contract: `0xdec0000000000000000000000000000000000000`

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run with hot reload |
| `npm run start` | Run the bot (continuous mode) |
| `npm run start:once` | Run single quote cycle (for testing) |
| `npm run fund` | Get testnet tokens |
| `npm run balances` | Check all balances |
| `npm run approve` | Approve DEX spending |
| `npm run typecheck` | Check TypeScript types |

## License

MIT

## Disclaimer

This is testnet software for educational and development purposes. Not financial advice.
