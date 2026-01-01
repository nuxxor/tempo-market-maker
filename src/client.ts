import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  type Address,
  publicActions,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { tempoTestnet } from 'viem/chains';
import { tempoActions } from 'viem/tempo';
import { config, getPrivateKey, TOKENS } from './config.js';
import { logger } from './logger.js';

// Extend tempoTestnet with fee token
const tempoChain = {
  ...tempoTestnet,
  feeToken: TOKENS.AlphaUSD, // Default fee token
} as const;

// Client instances (using any to avoid complex viem type issues)
let tempoClient: any = null;
let publicClientHttp: any = null;
let publicClientWs: any = null;
let makerAccount: ReturnType<typeof privateKeyToAccount> | null = null;

/**
 * Create a Tempo client with DEX actions
 */
function createTempoClient() {
  const account = getMakerAccount();
  return createWalletClient({
    account,
    chain: tempoChain,
    transport: http(config.rpc),
  })
    .extend(publicActions)
    .extend(tempoActions());
}

/**
 * Get or create Tempo client with DEX actions
 */
export function getTempoClient() {
  if (!tempoClient) {
    tempoClient = createTempoClient();
    logger.debug('preflight', { message: `Tempo client created with DEX actions` });
  }
  return tempoClient;
}

/**
 * Get or create HTTP public client (for basic queries)
 */
export function getPublicClientHttp() {
  if (!publicClientHttp) {
    publicClientHttp = createPublicClient({
      chain: tempoTestnet,
      transport: http(config.rpc),
    });
    logger.debug('preflight', { message: `HTTP public client created: ${config.rpc}` });
  }
  return publicClientHttp;
}

/**
 * Get or create WebSocket public client for event watching
 */
export function getPublicClientWs() {
  if (!publicClientWs) {
    publicClientWs = createPublicClient({
      chain: tempoTestnet,
      transport: webSocket(config.ws),
    });
    logger.debug('preflight', { message: `WebSocket public client created: ${config.ws}` });
  }
  return publicClientWs;
}

/**
 * Get or create wallet client (legacy, prefer getTempoClient)
 */
export function getWalletClient() {
  return getTempoClient();
}

/**
 * Get maker account from private key
 */
export function getMakerAccount(): ReturnType<typeof privateKeyToAccount> {
  if (!makerAccount) {
    const privateKey = getPrivateKey();
    makerAccount = privateKeyToAccount(privateKey);
    logger.debug('preflight', { message: `Maker account: ${makerAccount.address}` });
  }
  return makerAccount;
}

/**
 * Get maker address
 */
export function getMakerAddress(): Address {
  return getMakerAccount().address;
}

/**
 * Get fee token address based on config
 */
export function getFeeTokenAddress(): Address {
  return TOKENS[config.feeToken];
}

/**
 * Test RPC connection
 */
export async function testConnection(): Promise<boolean> {
  try {
    const client = getPublicClientHttp();
    const blockNumber = await client.getBlockNumber();
    logger.info('preflight', {
      message: `RPC connected. Block number: ${blockNumber}`,
    });
    return true;
  } catch (error) {
    logger.error('preflight', {
      error: error instanceof Error ? error.message : 'Unknown error',
      message: 'Failed to connect to RPC',
    });
    return false;
  }
}

/**
 * Test WebSocket connection
 */
export async function testWsConnection(): Promise<boolean> {
  try {
    const client = getPublicClientWs();
    const blockNumber = await client.getBlockNumber();
    logger.info('preflight', {
      message: `WebSocket connected. Block number: ${blockNumber}`,
    });
    return true;
  } catch (error) {
    logger.error('preflight', {
      error: error instanceof Error ? error.message : 'Unknown error',
      message: 'Failed to connect to WebSocket',
    });
    return false;
  }
}

/**
 * Initialize all clients and test connections
 */
export async function initializeClients(): Promise<{
  httpOk: boolean;
  wsOk: boolean;
  makerAddress: Address;
}> {
  logger.info('preflight', { message: 'Initializing clients...' });

  // Initialize account first
  const account = getMakerAccount();

  // Initialize Tempo client
  getTempoClient();

  // Test HTTP
  const httpOk = await testConnection();

  // Test WebSocket (optional, can fallback to polling)
  const wsOk = await testWsConnection();

  return {
    httpOk,
    wsOk,
    makerAddress: account.address,
  };
}

/**
 * Clean up clients (for graceful shutdown)
 */
export function cleanupClients(): void {
  if (publicClientWs) {
    publicClientWs = null;
  }
  publicClientHttp = null;
  tempoClient = null;
  logger.debug('preflight', { message: 'Clients cleaned up' });
}
