import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function createHermesDriver({ python = process.env.A2A_HERMES_PYTHON || 'python3',
  binary = process.env.A2A_HERMES_BINARY, timeoutMs = 600000, execute = run, env = process.env } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error('Invalid Hermes task timeout');
  const controller = new AbortController();
  const create = () => {
    let session;
    return { async run(text) {
      const args = [...(binary ? [] : ['-m', 'hermes_cli.main']), 'chat', '--quiet', '--query', text];
      if (session) args.push('--resume', session);
      const { stdout, stderr } = await execute(binary || python, args, {
        timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, signal: controller.signal,
        env: { ...env, A2A_CONNECTOR_CHILD: '1' },
      });
      // Quiet CLI stdout is the final reply; the last stderr ID follows session compaction.
      const ids = [...stderr.matchAll(/^session_id:\s*([A-Za-z0-9][A-Za-z0-9_.:-]*)\s*$/gm)];
      if (!stdout.trim() || !ids.length) throw new Error('Hermes quiet CLI returned no text/session ID; this CLI is unsupported');
      session = ids.at(-1)[1];
      return stdout.trim();
    } };
  };
  create.close = () => controller.abort();
  return create;
}
