import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { saveEnrollment } from './vendor/connector/connector.js';

const queues = new Map();
export const terminal = task => ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED', 'TASK_STATE_CANCELED'].includes(task.state);

/** One runner owns the file; transactions also serialize concurrent HTTP requests. */
export class TaskStore {
  constructor(path, { maxRecords = 256, retentionMs = 7 * 86400000 } = {}) {
    this.path = resolve(path);
    this.maxRecords = maxRecords;
    this.retentionMs = retentionMs;
    if (!queues.has(this.path)) queues.set(this.path, Promise.resolve());
  }

  async read() {
    try {
      const info = await stat(this.path);
      if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('WorkBuddy task journal must be private (0600)');
      if (info.size > 32 * 1024 * 1024) throw new Error('WorkBuddy task journal is too large');
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.tasks) || value.tasks.some(task =>
        !task || typeof task.id !== 'string' || typeof task.messageId !== 'string' || typeof task.state !== 'string')) {
        throw new Error('Invalid WorkBuddy task journal');
      }
      return value.tasks;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async list() {
    await queues.get(this.path);
    return this.read();
  }

  transact(update) {
    const operation = queues.get(this.path).then(async () => {
      let tasks = await this.read();
      const result = await update(tasks);
      const keep = task => !terminal(task) || Date.now() - Date.parse(task.updatedAt) < this.retentionMs;
      tasks = tasks.filter(keep);
      if (tasks.length > this.maxRecords) throw new Error('WorkBuddy task capacity reached; retain active tasks and archive terminal tasks first');
      if (Buffer.byteLength(JSON.stringify(tasks)) > 32 * 1024 * 1024 - 1024) throw new Error('WorkBuddy task journal capacity reached');
      await saveEnrollment(this.path, { version: 1, tasks });
      return structuredClone(result);
    });
    queues.set(this.path, operation.catch(() => {}));
    return operation;
  }
}
