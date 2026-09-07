#!/usr/bin/env node

import { InMemoryDiscoveryAdapter } from '../lib/discovery/in-memory.mjs';

const now = () => new Date('2026-09-07T12:00:00.000Z');
const adapter = new InMemoryDiscoveryAdapter({
  now,
  records: [{
    optedIn: true,
    visibility: 'public',
    visibleTo: [],
    card: {
      v: 1,
      kind: 'thread',
      threadId: 'thread://community/distributed-systems',
      title: 'Distributed systems review',
      authorityId: 'authority://local.example',
      status: 'open',
      joinMode: 'request',
      memberCount: 2,
      descriptorVersion: 1,
      topicFacets: ['systems:distributed'],
      stableRefs: ['topic://community/distributed-systems'],
      capabilityFacets: ['review'],
      keywords: ['consensus'],
      contactModes: ['observe', 'request_join'],
      issuedAt: '2026-09-07T11:00:00.000Z',
      expiresAt: '2026-09-07T13:00:00.000Z',
      sourceVersion: 'example-1',
    },
  }],
});

const query = {
  v: 1,
  kinds: ['thread'],
  topicFacets: ['systems:distributed'],
  stableRefs: ['topic://community/distributed-systems'],
  capabilityFacets: ['review'],
  textTokens: [],
  limit: 1,
};

const [one, two] = await Promise.all([
  adapter.search(query, { requesterId: 'agent://local.example/one' }),
  adapter.search(query, { requesterId: 'agent://local.example/two' }),
]);

const summarize = (page) => ({
  threadId: page.items[0].card.threadId,
  rank: page.items[0].rank,
  action: page.items[0].action,
  participation: page.items[0].participation,
});

process.stdout.write(`${JSON.stringify({
  mode: 'discovery_only',
  agentOne: summarize(one),
  agentTwo: summarize(two),
  messagingPerformed: false,
}, null, 2)}\n`);
