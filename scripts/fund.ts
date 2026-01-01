/**
 * Fund script - Get tokens from Tempo Testnet faucet
 *
 * Usage: npm run fund
 *
 * This script requests tokens from the Tempo testnet faucet.
 * Faucet provides: 1M pathUSD, 1M AlphaUSD, 1M BetaUSD, 1M ThetaUSD
 */

import 'dotenv/config';
import { getPublicClientHttp, getMakerAddress, initializeClients } from '../src/client.js';
import { logger } from '../src/logger.js';
import { config, TOKENS } from '../src/config.js';

// Faucet contract address (if available via contract call)
// Otherwise we'll use the tempo_fundAddress RPC method
const FAUCET_ADDRESS = '0xfauc000000000000000000000000000000000000' as const;

async function fundViaRpc(): Promise<boolean> {
  const client = getPublicClientHttp();
  const makerAddress = getMakerAddress();

  logger.info('preflight', { message: `Requesting faucet funds for: ${makerAddress}` });

  try {
    // Try tempo_fundAddress RPC method
    const result = await client.request({
      method: 'tempo_fundAddress' as any,
      params: [makerAddress],
    });

    logger.info('preflight', {
      message: 'Faucet request successful via RPC',
    });
    console.log('\nFaucet response:', result);
    return true;
  } catch (error) {
    // RPC method might not be available, try alternative
    logger.warn('preflight', {
      message: 'tempo_fundAddress RPC method not available, trying alternative...',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

async function fundViaHttp(): Promise<boolean> {
  const makerAddress = getMakerAddress();

  logger.info('preflight', { message: 'Trying HTTP faucet endpoint...' });

  try {
    // Try common faucet endpoint patterns
    const faucetUrls = [
      `https://faucet.testnet.tempo.xyz/fund?address=${makerAddress}`,
      `https://api.testnet.tempo.xyz/faucet?address=${makerAddress}`,
    ];

    for (const url of faucetUrls) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: makerAddress }),
        });

        if (response.ok) {
          const data = await response.json();
          logger.info('preflight', {
            message: `Faucet request successful via HTTP: ${url}`,
          });
          console.log('\nFaucet response:', data);
          return true;
        }
      } catch {
        // Try next URL
        continue;
      }
    }

    return false;
  } catch (error) {
    logger.warn('preflight', {
      message: 'HTTP faucet request failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

async function main() {
  logger.banner();
  logger.text('info', '=== TEMPO FAUCET FUND SCRIPT ===\n');

  // Initialize clients
  const { httpOk, makerAddress } = await initializeClients();

  if (!httpOk) {
    logger.error('preflight', { message: 'Failed to connect to RPC. Exiting.' });
    process.exit(1);
  }

  console.log(`Maker Address: ${makerAddress}`);
  console.log(`Network: ${config.rpc}\n`);

  // Try RPC method first
  let success = await fundViaRpc();

  // If RPC fails, try HTTP
  if (!success) {
    success = await fundViaHttp();
  }

  if (!success) {
    console.log('\n' + '='.repeat(60));
    console.log('MANUAL FAUCET INSTRUCTIONS');
    console.log('='.repeat(60));
    console.log('\nAutomatic faucet request failed. Please fund manually:\n');
    console.log('1. Go to: https://docs.tempo.xyz/quickstart/faucet');
    console.log('2. Connect your wallet');
    console.log(`3. Use address: ${makerAddress}`);
    console.log('4. Request funds\n');
    console.log('Expected tokens:');
    Object.entries(TOKENS).forEach(([symbol, address]) => {
      console.log(`  - 1,000,000 ${symbol}: ${address}`);
    });
    console.log('\n' + '='.repeat(60));
  }

  // Show current balances after funding attempt
  console.log('\nCurrent balances will be shown after running: npm run balances');
}

main().catch((error) => {
  logger.error('preflight', {
    message: 'Fund script failed',
    error: error instanceof Error ? error.message : 'Unknown error',
  });
  process.exit(1);
});
