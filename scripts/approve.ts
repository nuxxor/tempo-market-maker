/**
 * Approve script - Approve tokens for DEX spending
 *
 * Usage: npm run approve
 *
 * Approves all required spend tokens for the configured trading pairs.
 * - Buy orders spend quote token
 * - Sell orders spend base token
 *
 * This means for each pair, both base AND quote tokens need approval.
 */

import 'dotenv/config';
import { maxUint256 } from 'viem';
import { initializeClients, getMakerAddress } from '../src/client.js';
import { getAllowance, approveToken, getTokenAddress, formatBalance, getDecimals } from '../src/tokens.js';
import { logger } from '../src/logger.js';
import { config, TOKENS, DEX_ADDRESS, type TokenSymbol } from '../src/config.js';

async function main() {
  logger.banner();
  logger.text('info', '=== TOKEN APPROVAL SCRIPT ===\n');

  // Initialize clients
  const { httpOk, makerAddress } = await initializeClients();

  if (!httpOk) {
    logger.error('preflight', { message: 'Failed to connect to RPC. Exiting.' });
    process.exit(1);
  }

  console.log(`Maker Address: ${makerAddress}`);
  console.log(`DEX Address: ${DEX_ADDRESS}`);
  console.log(`Network: ${config.rpc}\n`);

  // Collect all unique tokens that need approval
  const tokensToApprove = new Set<TokenSymbol>();

  const enabledPairs = config.pairs.filter(p => p.enabled);
  console.log(`Enabled pairs: ${enabledPairs.length}\n`);

  for (const pair of enabledPairs) {
    // Buy order: spend quote token
    tokensToApprove.add(pair.quote);
    // Sell order: spend base token
    tokensToApprove.add(pair.base);

    console.log(`  ${pair.base}/${pair.quote}`);
    console.log(`    - Buy: spends ${pair.quote}`);
    console.log(`    - Sell: spends ${pair.base}`);
  }

  console.log(`\nTokens requiring approval: ${[...tokensToApprove].join(', ')}\n`);

  // Check and approve each token
  console.log('='.repeat(60));
  console.log('APPROVAL STATUS');
  console.log('='.repeat(60) + '\n');

  let approvalCount = 0;
  let alreadyApprovedCount = 0;
  let failedCount = 0;

  for (const symbol of tokensToApprove) {
    const address = getTokenAddress(symbol);
    const decimals = await getDecimals(address);

    console.log(`${symbol} (${address})`);

    try {
      // Check current allowance
      const currentAllowance = await getAllowance(address, DEX_ADDRESS);
      const formattedAllowance = formatBalance(currentAllowance, decimals);

      // If already max approved, skip
      if (currentAllowance >= maxUint256 / 2n) {
        console.log(`  ✅ Already approved (unlimited)`);
        alreadyApprovedCount++;
        continue;
      }

      // If some allowance exists
      if (currentAllowance > 0n) {
        console.log(`  ⚠️  Current allowance: ${formattedAllowance}`);
      } else {
        console.log(`  ❌ No allowance`);
      }

      // Approve
      console.log(`  🔄 Approving unlimited spending...`);

      const { txHash, success } = await approveToken(address, DEX_ADDRESS);

      if (success) {
        console.log(`  ✅ Approved! TX: ${txHash}`);
        approvalCount++;
      } else {
        console.log(`  ❌ Approval failed`);
        failedCount++;
      }
    } catch (error) {
      console.log(`  ❌ Error: ${error instanceof Error ? error.message : 'Unknown'}`);
      failedCount++;
    }

    console.log('');
  }

  // Summary
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`\nTotal tokens: ${tokensToApprove.size}`);
  console.log(`  ✅ Already approved: ${alreadyApprovedCount}`);
  console.log(`  🆕 Newly approved: ${approvalCount}`);
  console.log(`  ❌ Failed: ${failedCount}`);

  if (failedCount === 0) {
    console.log('\n✅ All tokens approved for DEX trading!');
    console.log('\nNext step: Run the bot with `npm run start`');
  } else {
    console.log('\n⚠️  Some approvals failed. Please check errors above.');
  }
}

main().catch((error) => {
  logger.error('preflight', {
    message: 'Approve script failed',
    error: error instanceof Error ? error.message : 'Unknown error',
  });
  process.exit(1);
});
