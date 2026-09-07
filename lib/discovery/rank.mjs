import {
  DISCOVERY_LIMITS,
  DiscoveryValidationError,
  deepFreeze,
  discoveryCardKey,
  readClock,
  validateDiscoveryCard,
  validateDiscoveryQuery,
} from './contracts.mjs';

const EVIDENCE_ORDER = Object.freeze({
  stable_ref: 0,
  topic_facet: 1,
  capability_facet: 2,
  text_token: 3,
});

const RANK_WEIGHT = Object.freeze({ exact: 3, strong: 2, weak: 1 });

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function matches(queryValues, cardValues, kind) {
  const available = new Set(cardValues);
  return queryValues.filter((value) => available.has(value)).map((value) => ({ kind, value }));
}

function suggestionFor(query, card) {
  const stable = matches(query.stableRefs, card.stableRefs, 'stable_ref');
  const topics = matches(query.topicFacets, card.topicFacets, 'topic_facet');
  const capabilities = matches(query.capabilityFacets, card.capabilityFacets, 'capability_facet');
  const tokens = matches(query.textTokens, card.keywords, 'text_token');
  const evidence = [...stable, ...topics, ...capabilities, ...tokens].sort((left, right) =>
    EVIDENCE_ORDER[left.kind] - EVIDENCE_ORDER[right.kind] || compareStrings(left.value, right.value));
  if (evidence.length === 0) return undefined;

  let rank;
  let score;
  if (stable.length > 0) {
    rank = 'exact';
    score = 300000 + stable.length * 1000 + (topics.length + capabilities.length) * 10 + tokens.length;
  } else if (topics.length + capabilities.length > 0) {
    rank = 'strong';
    score = 200000 + (topics.length + capabilities.length) * 100 + tokens.length;
  } else {
    rank = 'weak';
    score = 100000 + tokens.length;
  }

  return deepFreeze({
    v: 1,
    card,
    rank,
    score,
    evidence,
    action: 'suggest_only',
    authorization: 'required',
    participation: 'unverified',
  });
}

/**
 * Rank cards that an adapter already filtered for opt-in and caller visibility.
 * This function validates cards but performs no authorization.
 */
export function rankDiscoveryCards(queryValue, cardValues, options = {}) {
  const query = validateDiscoveryQuery(queryValue);
  if (!Array.isArray(cardValues) || cardValues.length > DISCOVERY_LIMITS.cardsPerAdapter) {
    throw new DiscoveryValidationError('invalid_type', '/cards', `expected at most ${DISCOVERY_LIMITS.cardsPerAdapter} cards`);
  }
  const now = readClock(options.now ?? (() => new Date()));
  const seen = new Set();
  const suggestions = [];

  for (const [index, value] of cardValues.entries()) {
    let card;
    try {
      card = validateDiscoveryCard(value, { now });
    } catch (error) {
      if (error instanceof DiscoveryValidationError) {
        throw new DiscoveryValidationError(error.code, `/cards/${index}${error.pointer}`, error.message);
      }
      throw error;
    }
    const key = discoveryCardKey(card);
    if (seen.has(key)) {
      throw new DiscoveryValidationError('duplicate_card', `/cards/${index}`, 'card IDs must be unique');
    }
    seen.add(key);
    if (!query.kinds.includes(card.kind)) continue;
    const suggestion = suggestionFor(query, card);
    if (suggestion) suggestions.push(suggestion);
  }

  suggestions.sort((left, right) =>
    RANK_WEIGHT[right.rank] - RANK_WEIGHT[left.rank] ||
    right.score - left.score ||
    compareStrings(discoveryCardKey(left.card), discoveryCardKey(right.card)) ||
    compareStrings(left.card.sourceVersion, right.card.sourceVersion));
  return deepFreeze(suggestions);
}

export function discoverySuggestionKey(suggestion) {
  return `${RANK_WEIGHT[suggestion.rank]}:${String(suggestion.score).padStart(6, '0')}:${discoveryCardKey(suggestion.card)}:${suggestion.card.sourceVersion}`;
}
