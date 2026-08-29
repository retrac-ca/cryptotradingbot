/**
 * NDAX adapter entrypoint — registers the exchange with the registry.
 *
 * Credential key names expected from config (retail NDAX auth model, ⚠️ the
 * retail API needs APIKey + API Secret + UserId + Nonce, not a simple key/secret
 * pair):
 *   NDAX_API_KEY
 *   NDAX_API_SECRET
 *   NDAX_USER_ID      (numeric user id)
 */

import { registerExchange } from '../registry.js';
import { NdaxAdapter } from './NdaxAdapter.js';

export { NdaxAdapter } from './NdaxAdapter.js';
export { ndaxSignature, ndaxNonce, signaturesMatch, isHexDigest } from './signing.js';
export { mapLevel1ToTicker, mapInstrumentToMarketInfo, mapOrder, mapL2ToOrderBook, mapTickerHistoryRow } from './mappings.js';

registerExchange('ndax', ({ credentials, config }) => {
  return new NdaxAdapter({
    credentials: {
      apiKey: credentials.apiKey ?? '',
      apiSecret: credentials.apiSecret ?? '',
      userId: credentials.userId ?? '',
      userName: credentials.userName ?? '',
      accountId: credentials.accountId ? Number(credentials.accountId) : undefined,
    },
    baseUrl: (config?.baseUrl as string | undefined) ?? undefined,
    enableAuthenticatedReads:
      (config?.enableAuthenticatedReads as boolean | undefined) ?? false,
  });
});
