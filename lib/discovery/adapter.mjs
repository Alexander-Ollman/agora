import {
  DiscoveryValidationError,
  validateDiscoveryAccess,
  validateDiscoveryPage,
  validateDiscoveryQuery,
} from './contracts.mjs';
import { rankDiscoveryCards } from './rank.mjs';

/**
 * @typedef {object} DiscoveryAdapterV1
 * @property {(query: unknown, access: unknown) => Promise<unknown>} search
 */

/** Fail early when a deployment adapter does not implement the S1 search port. */
export function assertDiscoveryAdapter(value) {
  if (!value || typeof value !== 'object' || typeof value.search !== 'function') {
    throw new TypeError('discovery adapter must implement search(query, access)');
  }
  return value;
}

/** Validate both sides of an external adapter call. */
export async function searchDiscovery(adapterValue, queryValue, accessValue) {
  const adapter = assertDiscoveryAdapter(adapterValue);
  const query = validateDiscoveryQuery(queryValue);
  const access = validateDiscoveryAccess(accessValue);
  const page = validateDiscoveryPage(await adapter.search(query, access));
  const expected = rankDiscoveryCards(query, page.items.map((item) => item.card), {
    now: new Date(page.observedAt),
  });
  if (JSON.stringify(page.items) !== JSON.stringify(expected)) {
    throw new DiscoveryValidationError('invalid_result', '/items', 'adapter results do not match the query evidence and deterministic rank');
  }
  return page;
}

/**
 * Base class for deployment adapters.
 * Implementations authenticate the caller and filter opt-in visibility before ranking.
 */
export class DiscoveryAdapter {
  async search(_query, _access) {
    throw new Error('discovery adapter search is not implemented');
  }
}
