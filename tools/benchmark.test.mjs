import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertComparable,
  gradeTrial,
  runCommandAdapter,
  runBenchmark,
} from './benchmark.mjs';

const shared = {
  model: 'fixture-model',
  gateway: 'fixture-gateway',
  catalogue_sha256: 'abc123',
  environment_sha256: 'def456',
};

test('rejects trials whose model, gateway, catalogue, or environment differ', () => {
  assert.throws(
    () => assertComparable([
      { mode: 'per-row-mcp', ...shared },
      { mode: 'deferred-tool-search', ...shared, model: 'different-model' },
      { mode: 'protocol-only', ...shared },
    ]),
    /model differs/,
  );
});

test('grades full task success instead of accepting a plausible final string', () => {
  const task = {
    id: 'create-resolve-invoke',
    required_events: ['created', 'resolved', 'invoked', 'receipted'],
    expected: { result: 5 },
  };
  assert.deepEqual(
    gradeTrial(task, {
      final: { result: 5 },
      events: ['created', 'resolved', 'invoked'],
    }),
    {
      success: false,
      final_match: true,
      missing_events: ['receipted'],
    },
  );
});

test('runs all modes and writes raw JSONL plus machine and human summaries', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'oip-benchmark-'));
  const tasks = [{
    id: 'invoke-add',
    prompt: 'Invoke add with 2 and 3.',
    required_events: ['resolved', 'invoked', 'receipted'],
    expected: { result: 5 },
  }];
  const adapters = Object.fromEntries(
    ['per-row-mcp', 'deferred-tool-search', 'protocol-only'].map((mode) => [
      mode,
      async ({ trial }) => ({
        ...shared,
        mode,
        final: { result: 5 },
        events: ['resolved', 'invoked', 'receipted'],
        input_tokens: mode === 'per-row-mcp' ? 1000 : 100,
        output_tokens: 10,
        cost_usd: mode === 'per-row-mcp' ? 0.01 : 0.001,
        latency_ms: 25,
        trial,
      }),
    ]),
  );

  const report = await runBenchmark({
    tasks,
    adapters,
    repetitions: 2,
    outputDir,
    metadata: shared,
  });

  assert.equal(report.trials.length, 6);
  assert.equal(report.summary.every((row) => row.task_success_rate === 1), true);
  assert.equal(report.structural_claim, 'standing context stays independent of catalogue size');
  assert.equal(report.cost_claim, 'deferred Tool Search and protocol-only are effectively equal');

  const raw = await readFile(path.join(outputDir, 'trials.jsonl'), 'utf8');
  assert.equal(raw.trim().split('\n').length, 6);
  assert.match(await readFile(path.join(outputDir, 'summary.json'), 'utf8'), /catalogue_sha256/);
  assert.match(await readFile(path.join(outputDir, 'summary.md'), 'utf8'), /Full-task success/);
});

test('command adapters receive one bounded JSON request and return one JSON result', async () => {
  const adapter = runCommandAdapter({
    command: [
      process.execPath,
      '-e',
      "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const x=JSON.parse(s);process.stdout.write(JSON.stringify({mode:x.mode,final:x.task.expected,events:x.task.required_events}))})",
    ],
    mode: 'protocol-only',
    timeoutMs: 5_000,
  });
  const result = await adapter({
    task: { expected: { result: 5 }, required_events: ['invoked'] },
    trial: 1,
    metadata: shared,
  });
  assert.deepEqual(result, {
    mode: 'protocol-only',
    final: { result: 5 },
    events: ['invoked'],
  });
});
