import { type Address, parseUnits, formatUnits, maxUint256 } from 'viem';
import { getPublicClientHttp, getWalletClient, getMakerAddress, getMakerAccount } from './client.js';
import { TOKENS, DEX_ADDRESS, type TokenSymbol } from './config.js';
import { type TokenMetadata, type TokenBalance } from './types.js';
import { logger } from './logger.js';

// TIP-20 / ERC-20 ABI (subset we need)
const TIP20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    name: 'name',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

// Cache for token metadata
const metadataCache = new Map<Address, TokenMetadata>();

/**
 * Get token address from symbol
 */
export function getTokenAddress(symbol: TokenSymbol): Address {
  const address = TOKENS[symbol];
  if (!address) {
    throw new Error(`Unknown token symbol: ${symbol}`);
  }
  return address;
}

/**
 * Get token symbol from address
 */
export function getTokenSymbol(address: Address): TokenSymbol | null {
  for (const [symbol, addr] of Object.entries(TOKENS)) {
    if (addr.toLowerCase() === address.toLowerCase()) {
      return symbol as TokenSymbol;
    }
  }
  return null;
}

/**
 * Get token decimals (cached)
 */
export async function getDecimals(tokenAddress: Address): Promise<number> {
  const cached = metadataCache.get(tokenAddress);
  if (cached) {
    return cached.decimals;
  }

  const client = getPublicClientHttp();
  const decimals = await client.readContract({
    address: tokenAddress,
    abi: TIP20_ABI,
    functionName: 'decimals',
  });

  return Number(decimals);
}

/**
 * Get full token metadata
 */
export async function getTokenMetadata(tokenAddress: Address): Promise<TokenMetadata> {
  const cached = metadataCache.get(tokenAddress);
  if (cached) {
    return cached;
  }

  const client = getPublicClientHttp();

  const [decimals, symbol, name] = await Promise.all([
    client.readContract({
      address: tokenAddress,
      abi: TIP20_ABI,
      functionName: 'decimals',
    }),
    client.readContract({
      address: tokenAddress,
      abi: TIP20_ABI,
      functionName: 'symbol',
    }),
    client.readContract({
      address: tokenAddress,
      abi: TIP20_ABI,
      functionName: 'name',
    }),
  ]);

  // Note: transferPolicyId, quoteToken, currency are Tempo-specific
  // For now, we'll use placeholder values
  // These should be fetched via tempo-specific RPC calls in production
  const metadata: TokenMetadata = {
    decimals: Number(decimals),
    symbol: symbol as string,
    name: name as string,
    transferPolicyId: 0n, // TODO: Fetch from Tempo RPC
    quoteToken: null,
    currency: null,
  };

  metadataCache.set(tokenAddress, metadata);
  return metadata;
}

/**
 * Get wallet balance for a token
 */
export async function getWalletBalance(tokenAddress: Address): Promise<bigint> {
  const client = getPublicClientHttp();
  const makerAddress = getMakerAddress();

  const balance = await client.readContract({
    address: tokenAddress,
    abi: TIP20_ABI,
    functionName: 'balanceOf',
    args: [makerAddress],
  });

  return balance;
}

/**
 * Get allowance for DEX
 */
export async function getAllowance(tokenAddress: Address, spender: Address = DEX_ADDRESS): Promise<bigint> {
  const client = getPublicClientHttp();
  const makerAddress = getMakerAddress();

  const allowance = await client.readContract({
    address: tokenAddress,
    abi: TIP20_ABI,
    functionName: 'allowance',
    args: [makerAddress, spender],
  });

  return allowance;
}

/**
 * Approve token spending for DEX (max amount)
 */
export async function approveToken(
  tokenAddress: Address,
  spender: Address = DEX_ADDRESS,
  amount: bigint = maxUint256
): Promise<{ txHash: `0x${string}`; success: boolean }> {
  const walletClient = getWalletClient();
  const publicClient = getPublicClientHttp();

  try {
    const account = getMakerAccount();
    const txHash = await walletClient.writeContract({
      account,
      address: tokenAddress,
      abi: TIP20_ABI,
      functionName: 'approve',
      args: [spender, amount],
    });

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    const symbol = getTokenSymbol(tokenAddress) || tokenAddress;
    logger.txSuccess({
      reason: 'allowance',
      txHash,
      gasUsed: receipt.gasUsed,
    });
    logger.info('allowance', {
      message: `Approved ${symbol} for DEX spending`,
    });

    return { txHash, success: receipt.status === 'success' };
  } catch (error) {
    logger.txFailed({
      reason: 'allowance',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

/**
 * Check if token has sufficient allowance for DEX
 */
export async function hasAllowance(tokenAddress: Address, requiredAmount: bigint): Promise<boolean> {
  const allowance = await getAllowance(tokenAddress);
  return allowance >= requiredAmount;
}

/**
 * Ensure token has sufficient allowance, approve if needed
 */
export async function ensureAllowance(
  tokenAddress: Address,
  requiredAmount: bigint = maxUint256
): Promise<boolean> {
  const allowance = await getAllowance(tokenAddress);

  if (allowance >= requiredAmount) {
    const symbol = getTokenSymbol(tokenAddress) || tokenAddress;
    logger.debug('allowance', {
      message: `${symbol} already has sufficient allowance`,
    });
    return true;
  }

  const { success } = await approveToken(tokenAddress);
  return success;
}

/**
 * Get full balance info for a token (wallet + DEX)
 */
export async function getTokenBalance(symbol: TokenSymbol): Promise<TokenBalance> {
  const address = getTokenAddress(symbol);
  const [walletBalance, decimals] = await Promise.all([
    getWalletBalance(address),
    getDecimals(address),
  ]);

  // DEX internal balance would need Tempo-specific RPC
  // For now, return 0 as placeholder
  const dexBalance = 0n; // TODO: Implement via dex.getBalance

  return {
    symbol,
    address,
    walletBalance,
    dexBalance,
    decimals,
  };
}

/**
 * Get all token balances
 */
export async function getAllBalances(): Promise<TokenBalance[]> {
  const symbols = Object.keys(TOKENS) as TokenSymbol[];
  return Promise.all(symbols.map(getTokenBalance));
}

/**
 * Format balance for display
 */
export function formatBalance(balance: bigint, decimals: number): string {
  return formatUnits(balance, decimals);
}

/**
 * Parse human-readable amount to bigint
 */
export function parseAmount(amount: string, decimals: number): bigint {
  return parseUnits(amount, decimals);
}
