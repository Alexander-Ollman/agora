import { createHash } from 'node:crypto';

import { DiscoveryAdapter } from './adapter.mjs';
import {
  DISCOVERY_LIMITS,
  DiscoveryValidationError,
  deepFreeze,
  discoveryCardKey,
  readClock,
  validateDiscoveryAccess,
  validateDiscoveryPage,
  validateDiscoveryQuery,
  validateDiscoveryRecord,
} from './contracts.mjs';
import { discoverySuggestionKey, rankDiscoveryCards } from './rank.mjs';

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function suggestionDigest(suggestion) {
  return digest(discoverySuggestionKey(suggestion));
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new DiscoveryValidationError('invalid_cursor', '/cursor', 'cursor is not valid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'afterDigest,queryDigest,snapshotDigest,v' ||
      parsed.v !== 1 || !/^[0-9a-f]{64}$/.test(parsed.afterDigest) ||
      !/^[0-9a-f]{64}$/.test(parsed.queryDigest) || !/^[0-9a-f]{64}$/.test(parsed.snapshotDigest)) {
    throw new DiscoveryValidationError('invalid_cursor', '/cursor', 'cursor does not match the closed contract');
  }
  return parsed;
}

function queryWithoutCursor(query) {
  return {
    v: query.v,
    kinds: query.kinds,
    topicFacets: query.topicFacets,
    stableRefs: query.stableRefs,
    capabilityFacets: query.capabilityFacets,
    textTokens: query.textTokens,
    limit: query.limit,
  };
}

/** Dependency-free adapter used by conformance tests and local discovery. */
export class InMemoryDiscoveryAdapter extends DiscoveryAdapter {
  #now;
  #records;

  constructor(options) {
    super();
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some((key) => !['records', 'now'].includes(key)) ||
        !Object.hasOwn(options, 'records')) {
      throw new DiscoveryValidationError('invalid_shape', '', 'adapter options require records and optional now');
    }
    if (!Array.isArray(options.records) || options.records.length > DISCOVERY_LIMITS.cardsPerAdapter) {
      throw new DiscoveryValidationError('invalid_type', '/records', `expected at most ${DISCOVERY_LIMITS.cardsPerAdapter} records`);
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new DiscoveryValidationError('invalid_clock', '/now', 'now must be a function');
    }
    this.#now = options.now ?? (() => new Date());
    const seen = new Set();
    this.#records = options.records.map((value, index) => {
      let record;
      try {
        record = validateDiscoveryRecord(value);
      } catch (error) {
        if (error instanceof DiscoveryValidationError) {
          throw new DiscoveryValidationError(error.code, `/records/${index}${error.pointer}`, error.message);
        }
        throw error;
      }
      const key = discoveryCardKey(record.card);
      if (seen.has(key)) {
        throw new DiscoveryValidationError('duplicate_card', `/records/${index}/card`, 'record card IDs must be unique');
      }
      seen.add(key);
      return record;
    });
    deepFreeze(this.#records);
  }

  async search(queryValue, accessValue) {
    const query = validateDiscoveryQuery(queryValue);
    const access = validateDiscoveryAccess(accessValue);
    const observed = readClock(this.#now);
    const nowMs = observed.getTime();
    const visibleCards = this.#records
      .filter((record) => record.optedIn)
      .filter((record) => record.visibility === 'public' || record.visibleTo.includes(access.requesterId))
      .map((record) => record.card)
      .filter((card) => Date.parse(card.issuedAt) <= nowMs && nowMs < Date.parse(card.expiresAt))
      .sort((left, right) => compareStrings(discoveryCardKey(left), discoveryCardKey(right)));

    const ranked = rankDiscoveryCards(query, visibleCards, { now: observed });
    const queryDigest = digest(queryWithoutCursor(query));
    const snapshotDigest = digest(visibleCards);
    let start = 0;

    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (cursor.queryDigest !== queryDigest) {
        throw new DiscoveryValidationError('cursor_query_mismatch', '/cursor', 'cursor belongs to another query');
      }
      if (cursor.snapshotDigest !== snapshotDigest) {
        throw new DiscoveryValidationError('cursor_stale', '/cursor', 'visible discovery snapshot changed');
      }
      const index = ranked.findIndex((suggestion) => suggestionDigest(suggestion) === cursor.afterDigest);
      if (index < 0) throw new DiscoveryValidationError('cursor_stale', '/cursor', 'cursor item is no longer ranked');
      start = index + 1;
    }

    const items = ranked.slice(start, start + query.limit);
    const hasMore = start + items.length < ranked.length;
    const nextCursor = hasMore ? encodeCursor({
      v: 1,
      queryDigest,
      snapshotDigest,
      afterDigest: suggestionDigest(items.at(-1)),
    }) : null;

    if (nextCursor && Buffer.byteLength(nextCursor, 'utf8') > DISCOVERY_LIMITS.cursorBytes) {
      throw new DiscoveryValidationError('cursor_too_large', '/cursor', 'generated cursor exceeds its bound');
    }

    return validateDiscoveryPage({
      v: 1,
      items,
      nextCursor,
      observedAt: observed.toISOString(),
    });
  }
}
