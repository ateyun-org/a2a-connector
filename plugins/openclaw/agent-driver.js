import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);

// The public CLI works on older hosts without importing newer plugin SDK paths.
export function createAgentDriver({ binary = 'openclaw', args = [], agent = 'main',
  timeoutMs = 600000, execute = run } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error('Invalid OpenClaw task timeout');
  return () => {
    const sessionId = randomUUID();
    return { async run(text) {
      const { stdout } = await execute(binary, [...args, 'agent', '--agent', agent,
        '--session-id', sessionId, '--message', text, '--json',
        '--timeout', String(Math.ceil(timeoutMs / 1000))],
      { timeout: timeoutMs + 10000, maxBuffer: 2 * 1024 * 1024 });
      const value = JSON.parse(stdout);
      const payloads = value.result?.payloads ?? value.payloads;
      if (value.ok === false || value.error || (value.status && value.status !== 'ok') ||
          !Array.isArray(payloads) || payloads.some(p => p.isError === true)) {
        throw new Error('OpenClaw agent did not complete successfully');
      }
      const output = payloads.filter(p => !p.isReasoning && typeof p.text === 'string')
        .map(p => p.text).join('\n');
      if (!output.trim()) throw new Error('OpenClaw agent returned no text');
      return output;
    } };
  };
}
