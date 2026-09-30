import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const queues = new Map();

/** A small durable index. Writes are serialized and atomically renamed. */
export class ConversationStore {
  constructor(path) {
    this.path = resolve(path);
    this.retentionMs = 30 * 86400000;
    this.maxRecords = 4096;
    if (!queues.has(this.path)) queues.set(this.path, Promise.resolve());
  }

  get pending() { return queues.get(this.path); }
  set pending(value) { queues.set(this.path, value); }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.conversations)) throw new Error('invalid A2A conversation store');
      return value.conversations;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async list(parentId) {
    await this.pending;
    return (await this.read()).filter(item => parentId === undefined || item.parentId === parentId);
  }

  async get(id) {
    await this.pending;
    return (await this.read()).find(item => item.id === id);
  }

  async put(item) {
    const operation = this.pending.then(async () => {
      let records = await this.read();
      const terminal = record => !['pending', 'unknown'].includes(record.dispatchState) && [3, 4, 5, 7].includes(record.state);
      records = records.filter(record => record.id === item.id || !terminal(record) || Date.now() - Date.parse(record.updatedAt) < this.retentionMs);
      while (records.length >= this.maxRecords && !records.some(record => record.id === item.id)) {
        const removable = records.filter(terminal).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))[0];
        if (!removable) throw new Error('A2A conversation capacity reached; reconcile active/unknown records first');
        records = records.filter(record => record.id !== removable.id);
      }
      const index = records.findIndex(record => record.id === item.id);
      if (index < 0) records.push(item);
      else records[index] = item;
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, conversations: records }, null, 2), { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
