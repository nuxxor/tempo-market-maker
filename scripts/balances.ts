/**
 * Balances script - Check wallet and DEX balances
 *
 * Usage: npm run balances
 *
 * Shows both wallet TIP-20 balances and DEX internal balances
 * for all configured tokens.
 */

import 'dotenv/config';
import { initializeClients, getMakerAddress, getPublicClientHttp } from '../src/client.js';
import { getAllBalances, formatBalance, getWalletBalance } from '../src/tokens.js';
import { logger } from '../src/logger.js';
import { config, TOKENS, DEX_ADDRESS } from '../src/config.js';
import type { Address } from 'viem';

// DEX ABI for getBalance (internal balance)
const DEX_BALANCE_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

async function getDexBalance(tokenAddress: Address, account: Address): Promise<bigint> {
  const client = getPublicClientHttp();

  try {
    const balance = await client.readContract({
      address: DEX_ADDRESS,
      abi: DEX_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [tokenAddress, account],
    });
    return balance;
  } catch (error) {
    // DEX balance might not be available, return 0
    return 0n;
  }
}

async function main() {
  logger.banner();
  logger.text('info', '=== TOKEN BALANCES ===\n');

  // Initialize clients
  const { httpOk, makerAddress } = await initializeClients();

  if (!httpOk) {
    logger.error('preflight', { message: 'Failed to connect to RPC. Exiting.' });
    process.exit(1);
  }

  console.log(`Maker Address: ${makerAddress}`);
  console.log(`DEX Address: ${DEX_ADDRESS}`);
  console.log(`Network: ${config.rpc}\n`);

  // Get balances
  console.log('Fetching balances...\n');

  const balances = await getAllBalances();

  // Table header
  console.log('┌─────────────┬────────────────────┬────────────────────┬────────────────────┐');
  console.log('│ Token       │ Wallet Balance     │ DEX Balance        │ Total              │');
  console.log('├─────────────┼────────────────────┼────────────────────┼────────────────────┤');

  let totalUsdValue = 0n;

  for (const balance of balances) {
    // Get DEX internal balance
    const dexBalance = await getDexBalance(balance.address, makerAddress);

    const walletFormatted = formatBalance(balance.walletBalance, balance.decimals);
    const dexFormatted = formatBalance(dexBalance, balance.decimals);
    const totalBalance = balance.walletBalance + dexBalance;
    const totalFormatted = formatBalance(totalBalance, balance.decimals);

    // Pad values for alignment
    const symbolPadded = balance.symbol.padEnd(11);
    const walletPadded = walletFormatted.padStart(18);
    const dexPadded = dexFormatted.padStart(18);
    const totalPadded = totalFormatted.padStart(18);

    console.log(`│ ${symbolPadded} │ ${walletPadded} │ ${dexPadded} │ ${totalPadded} │`);

    totalUsdValue += totalBalance;
  }

  console.log('└─────────────┴────────────────────┴────────────────────┴────────────────────┘');

  // Summary
  const decimals = 6; // All stablecoins use 6 decimals
  const totalFormatted = formatBalance(totalUsdValue, decimals);
  console.log(`\nTotal USD Value: $${totalFormatted}`);

  // Status check
  console.log('\n=== STATUS ===\n');

  const hasAnyBalance = balances.some(b => b.walletBalance > 0n);

  if (!hasAnyBalance) {
    console.log('⚠️  No tokens found. Run `npm run fund` to get testnet tokens.');
  } else {
    console.log('✅ Tokens available');

    // Check enabled pairs
    const enabledPairs = config.pairs.filter(p => p.enabled);
    console.log(`\nEnabled pairs: ${enabledPairs.length}`);

    for (const pair of enabledPairs) {
      const baseBalance = balances.find(b => b.symbol === pair.base);
      const quoteBalance = balances.find(b => b.symbol === pair.quote);

      const baseOk = baseBalance && baseBalance.walletBalance > 0n;
      const quoteOk = quoteBalance && quoteBalance.walletBalance > 0n;

      const status = baseOk && quoteOk ? '✅' : '⚠️';
      console.log(`  ${status} ${pair.base}/${pair.quote}`);
    }
  }
}

main().catch((error) => {
  logger.error('preflight', {
    message: 'Balances script failed',
    error: error instanceof Error ? error.message : 'Unknown error',
  });
  process.exit(1);
});
