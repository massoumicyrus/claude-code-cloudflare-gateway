import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODES = ['per-row-mcp', 'deferred-tool-search', 'protocol-only'];
const COMPARABILITY_FIELDS = ['model', 'gateway', 'catalogue_sha256', 'environment_sha256'];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function same(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

export function assertComparable(trials) {
  if (!trials.length) throw new Error('no benchmark trials');
  const baseline = trials[0];
  for (const trial of trials.slice(1)) {
    for (const field of COMPARABILITY_FIELDS) {
      if (!same(trial[field], baseline[field])) {
        throw new Error(`${field} differs between ${baseline.mode} and ${trial.mode}`);
      }
    }
  }
}

export function gradeTrial(task, result) {
  const events = new Set(result.events || []);
  const missingEvents = (task.required_events || []).filter((event) => !events.has(event));
  const finalMatch = same(task.expected, result.final);
  return {
    success: finalMatch && missingEvents.length === 0,
    final_match: finalMatch,
    missing_events: missingEvents,
  };
}

export function runCommandAdapter({ command, mode, timeoutMs = 120_000, env = {} }) {
  if (!Array.isArray(command) || !command.length) throw new Error('adapter command is required');
  return ({ task, trial, metadata }) => new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const limit = 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${mode} adapter timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > limit) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > limit) child.kill('SIGTERM');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${mode} adapter exited ${code}: ${stderr.slice(-2000)}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`${mode} adapter returned invalid JSON: ${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify({ mode, task, trial, metadata }));
  });
}

function mean(rows, field) {
  if (!rows.length) return 0;
  return rows.reduce((sum, row) => sum + Number(row[field] || 0), 0) / rows.length;
}

function summarize(trials) {
  return MODES.map((mode) => {
    const rows = trials.filter((trial) => trial.mode === mode);
    return {
      mode,
      trials: rows.length,
      task_success_rate: rows.filter((row) => row.grade.success).length / rows.length,
      mean_input_tokens: mean(rows, 'input_tokens'),
      mean_output_tokens: mean(rows, 'output_tokens'),
      mean_cost_usd: mean(rows, 'cost_usd'),
      mean_latency_ms: mean(rows, 'latency_ms'),
    };
  });
}

function costClaim(summary) {
  const deferred = summary.find((row) => row.mode === 'deferred-tool-search')?.mean_cost_usd || 0;
  const protocol = summary.find((row) => row.mode === 'protocol-only')?.mean_cost_usd || 0;
  const denominator = Math.max(deferred, protocol, Number.EPSILON);
  return Math.abs(deferred - protocol) / denominator <= 0.05
    ? 'deferred Tool Search and protocol-only are effectively equal'
    : 'measured costs differ; see the benchmark table';
}

function markdown(report) {
  const rows = report.summary.map((row) =>
    `| ${row.mode} | ${(row.task_success_rate * 100).toFixed(1)}% | ${row.mean_input_tokens.toFixed(1)} | ${row.mean_output_tokens.toFixed(1)} | $${row.mean_cost_usd.toFixed(6)} | ${row.mean_latency_ms.toFixed(1)} ms |`,
  ).join('\n');
  return `# Three-way capability access benchmark

All rows use the same model, gateway, catalogue snapshot, environment and task set. Success
requires the expected final value and every required lifecycle event; a plausible answer
without the required resolve/invoke/receipt path fails.

| Mode | Full-task success | Input tokens | Output tokens | Cost | Latency |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows}

- Structural result: ${report.structural_claim}.
- Cost result: ${report.cost_claim}.
- Catalogue snapshot: \`${report.metadata.catalogue_sha256}\`
- Environment: \`${report.metadata.environment_sha256}\`
- Model: \`${report.metadata.model}\`
- Gateway: \`${report.metadata.gateway}\`
`;
}

export async function runBenchmark({
  tasks,
  adapters,
  repetitions = 3,
  outputDir,
  metadata,
}) {
  for (const mode of MODES) {
    if (typeof adapters[mode] !== 'function') throw new Error(`missing adapter: ${mode}`);
  }
  const trials = [];
  for (const task of tasks) {
    for (let trial = 1; trial <= repetitions; trial += 1) {
      for (const mode of MODES) {
        const result = await adapters[mode]({ task, trial, metadata });
        trials.push({
          task_id: task.id,
          ...result,
          grade: gradeTrial(task, result),
        });
      }
    }
  }
  assertComparable(trials);
  const summary = summarize(trials);
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    metadata,
    repetitions,
    task_count: tasks.length,
    structural_claim: 'standing context stays independent of catalogue size',
    cost_claim: costClaim(summary),
    summary,
    trials,
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'trials.jsonl'), `${trials.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await writeFile(path.join(outputDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(outputDir, 'summary.md'), markdown(report));
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.stderr.write('Import runBenchmark from a reproducible adapter runner; direct execution is intentionally unsupported.\n');
  process.exitCode = 2;
}
