// Smoke tests for Undertow's core contracts.
//
// Pure-function tests that run without a Neo4j connection or .env file. These
// verify the most-load-bearing invariants — the project key contract and
// neuron-in-project filtering — that downstream daemons depend on.
//
// Run:
//   cd service && npm test
//
// Note: these run with no network and no DB. End-to-end tests against a live
// Neo4j + service belong in a separate integration suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapCwdToProject, isNeuronInProject } from '../daemons/impulse.js';

// --- mapCwdToProject ---

test('mapCwdToProject: null/empty returns null', () => {
  assert.strictEqual(mapCwdToProject(null), null);
  assert.strictEqual(mapCwdToProject(undefined), null);
  assert.strictEqual(mapCwdToProject(''), null);
  assert.strictEqual(mapCwdToProject('   '), null);
});

test('mapCwdToProject: lowercases and trims', () => {
  assert.strictEqual(mapCwdToProject('OpenClaw'), 'openclaw');
  assert.strictEqual(mapCwdToProject('  YourProject  '), 'yourproject');
  assert.strictEqual(mapCwdToProject('UPPER'), 'upper');
});

test('mapCwdToProject: passes paths through verbatim — no folder extraction', () => {
  // The contract is: cwd IS the key. No regex, no alias, no github/ assumption.
  // Two different paths produce two different keys, even if they share a basename.
  const a = mapCwdToProject('C:/Users/Alice/dev/auth-service');
  const b = mapCwdToProject('D:/projects/auth-service');
  assert.strictEqual(a, 'c:/users/alice/dev/auth-service');
  assert.strictEqual(b, 'd:/projects/auth-service');
  assert.notStrictEqual(a, b, 'distinct paths must produce distinct keys');
});

test('mapCwdToProject: same workspace produces same key across calls', () => {
  // Stable fingerprint — the only invariant downstream daemons rely on.
  const a = mapCwdToProject('/home/dev/MyApp');
  const b = mapCwdToProject('/home/dev/MyApp');
  assert.strictEqual(a, b);
});

test('mapCwdToProject: bare names from clients pass through', () => {
  // OpenClaw-style payload: short identifier sent directly.
  assert.strictEqual(mapCwdToProject('openclaw'), 'openclaw');
  assert.strictEqual(mapCwdToProject('discord-bot'), 'discord-bot');
});

// --- isNeuronInProject ---

test('isNeuronInProject: null projectTag returns true (no filter)', () => {
  assert.strictEqual(isNeuronInProject({ project: 'jaina' }, null), true);
  assert.strictEqual(isNeuronInProject({ project: 'jaina' }, undefined), true);
});

test('isNeuronInProject: same project returns true', () => {
  assert.strictEqual(isNeuronInProject({ project: 'mtg' }, 'mtg'), true);
});

test('isNeuronInProject: different project returns false (cross-domain)', () => {
  assert.strictEqual(isNeuronInProject({ project: 'jaina' }, 'mtg'), false);
});

test('isNeuronInProject: general-tagged neurons always pass', () => {
  // "general" is the catch-all bucket — always relevant.
  assert.strictEqual(isNeuronInProject({ project: 'general' }, 'mtg'), true);
  assert.strictEqual(isNeuronInProject({ project: 'general' }, 'jaina'), true);
});

test('isNeuronInProject: untagged neurons default to general (always pass)', () => {
  assert.strictEqual(isNeuronInProject({}, 'mtg'), true);
  assert.strictEqual(isNeuronInProject({ project: undefined }, 'mtg'), true);
});
