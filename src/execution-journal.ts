import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export type JournalPhase = "reserved" | "dispatched" | "succeeded" | "failed" | "uncertain";
export type JournalRecord = {
  requestId: string;
  toolName: string;
  fingerprint: string;
  phase: JournalPhase;
  createdAt: string;
  updatedAt: string;
  mutationCount: number;
  mutationTimestamps: string[];
  result?: unknown;
  message?: string;
};
export type JournalUpdate = { phase?: JournalPhase; mutationCount?: number; result?: unknown; message?: string };

type FileSystem = { writeTemporary(path: string, contents: string): Promise<void> };
type Reservation = { created: boolean; record: JournalRecord };
const locks = new Map<string, Promise<void>>();
const MAX_MUTATIONS_PER_RECORD = 10_000;
const fsImpl: FileSystem = { async writeTemporary(path, contents) { const handle = await open(path, "w"); try { await handle.writeFile(contents, "utf8"); await handle.sync(); } finally { await handle.close(); } } };

export class ExecutionJournal {
  constructor(private readonly directory: string, private readonly now: () => Date = () => new Date(), private readonly fileSystem: FileSystem = fsImpl) {}

  async get(requestId: string): Promise<JournalRecord | null> { return this.readRecord(requestId); }

  async reserve(toolName: string, requestId: string, input: unknown): Promise<Reservation> {
    return this.withLock(requestId, async () => {
      await mkdir(this.directory, { recursive: true });
      const fingerprint = sha256(`${toolName}:${canonicalJson(input)}`);
      const timestamp = this.now().toISOString();
      const record: JournalRecord = { requestId, toolName, fingerprint, phase: "reserved", createdAt: timestamp, updatedAt: timestamp, mutationCount: 0, mutationTimestamps: [] };
      try {
        await this.writeExclusive(this.pathFor(requestId), record);
        return { created: true, record };
      } catch (error: unknown) {
        if (!isAlreadyExists(error)) throw error;
        const existing = await this.readRecord(requestId);
        if (!existing) throw error;
        if (existing.toolName !== toolName || existing.fingerprint !== fingerprint) throw new Error("requestId was already used with different input");
        return { created: false, record: existing };
      }
    });
  }

  async update(requestId: string, patch: JournalUpdate): Promise<JournalRecord> { return this.withLock(requestId, () => this.applyUpdate(requestId, normalizePatch(patch, false))); }

  async markDispatched(requestId: string, mutationCount: number): Promise<JournalRecord> {
    return this.withLock(requestId, async () => {
      const record = await this.readRecord(requestId);
      if (!record) throw new Error("No journal record for requestId");
      if (!Number.isSafeInteger(mutationCount) || mutationCount < record.mutationCount || mutationCount > MAX_MUTATIONS_PER_RECORD) throw new Error("invalid mutation count");
      const added = mutationCount - record.mutationCount;
      const timestamp = this.now().toISOString();
      return this.applyUpdate(requestId, { phase: "dispatched", mutationCount, mutationTimestamps: [...record.mutationTimestamps, ...Array(added).fill(timestamp)] });
    });
  }

  async markSucceeded(requestId: string, result: unknown): Promise<JournalRecord> { return this.update(requestId, { phase: "succeeded", result }); }
  async markFailed(requestId: string, message: string, result?: unknown): Promise<JournalRecord> { return result === undefined ? this.update(requestId, { phase: "failed", message }) : this.update(requestId, { phase: "failed", message, result }); }
  async markUncertain(requestId: string, message: string): Promise<JournalRecord> { return this.update(requestId, { phase: "uncertain", message }); }

  async countMutations(utcDate: string): Promise<number> {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = parseRecord(await readFile(join(this.directory, entry.name), "utf8"));
      if (entry.name !== `${sha256(record.requestId)}.json`) throw new Error("execution journal is corrupt");
      total += record.mutationTimestamps.filter((timestamp) => timestamp.startsWith(utcDate)).length;
    }
    return total;
  }

  private async readRecord(requestId: string): Promise<JournalRecord | null> {
    try { const record = parseRecord(await readFile(this.pathFor(requestId), "utf8")); if (record.requestId !== requestId) throw new Error("execution journal is corrupt"); return record; }
    catch (error: unknown) { if (isNotFound(error)) return null; throw error; }
  }

  private async applyUpdate(requestId: string, patch: JournalUpdate & { mutationTimestamps?: string[] }): Promise<JournalRecord> {
    const record = await this.readRecord(requestId);
    if (!record) throw new Error("No journal record for requestId");
    if (record.phase === "succeeded" || record.phase === "failed") {
      if (unchangedTerminal(record, patch)) return record;
      throw new Error("terminal execution journal record is immutable");
    }
    const next: JournalRecord = {
      ...record,
      updatedAt: this.now().toISOString(),
      ...(patch.phase === undefined ? {} : { phase: patch.phase }),
      ...(patch.mutationCount === undefined ? {} : { mutationCount: patch.mutationCount }),
      ...(patch.mutationTimestamps === undefined ? {} : { mutationTimestamps: patch.mutationTimestamps }),
      ...(Object.hasOwn(patch, "result") ? { result: patch.result } : {}),
      ...(patch.message === undefined ? {} : { message: patch.message }),
    };
    assertTransition(record, next);
    validateRecord(next);
    await this.replaceRecord(requestId, next);
    return next;
  }

  private pathFor(requestId: string): string { return join(this.directory, `${sha256(requestId)}.json`); }

  private async writeExclusive(path: string, record: JournalRecord): Promise<void> {
    validateRecord(record);
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    let published = false;
    try { await this.fileSystem.writeTemporary(temp, JSON.stringify(record)); await fsLink(temp, path); published = true; }
    finally { try { await unlink(temp); } catch (error: unknown) { if (published && !isNotFound(error)) throw error; } }
  }

  private async replaceRecord(requestId: string, record: JournalRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const destination = this.pathFor(requestId);
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    try { await this.fileSystem.writeTemporary(temp, JSON.stringify(record)); await rename(temp, destination); }
    finally { try { await unlink(temp); } catch (error: unknown) { if (!isNotFound(error)) throw error; } }
  }

  private async withLock<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const key = `${this.directory}:${sha256(requestId)}`;
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    locks.set(key, tail);
    await previous;
    try { return await operation(); } finally { release(); if (locks.get(key) === tail) locks.delete(key); }
  }
}

function validateRecord(value: unknown): JournalRecord {
  if (!isObject(value)) throw new Error("execution journal is corrupt");
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== "string" || !record.requestId) throw new Error("execution journal is corrupt");
  if (typeof record.toolName !== "string" || !record.toolName) throw new Error("execution journal is corrupt");
  if (typeof record.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(record.fingerprint)) throw new Error("execution journal is corrupt");
  if (!isPhase(record.phase) || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") throw new Error("execution journal is corrupt");
  if (!Number.isSafeInteger(record.mutationCount) || (record.mutationCount as number) < 0 || (record.mutationCount as number) > MAX_MUTATIONS_PER_RECORD) throw new Error("execution journal is corrupt");
  if (!Array.isArray(record.mutationTimestamps) || !record.mutationTimestamps.every(isIsoTimestamp)) throw new Error("execution journal is corrupt");
  if (record.mutationCount !== record.mutationTimestamps.length) throw new Error("execution journal is corrupt");
  if (Object.hasOwn(record, "message") && typeof record.message !== "string") throw new Error("execution journal is corrupt");
  if (Object.hasOwn(record, "result") && !isJsonSafe(record.result)) throw new Error("execution journal is corrupt");
  return record as JournalRecord;
}

function parseRecord(text: string): JournalRecord { try { return validateRecord(JSON.parse(text)); } catch { throw new Error("execution journal is corrupt"); } }
function normalizePatch(patch: JournalUpdate, includeTimestamps: boolean): JournalUpdate & { mutationTimestamps?: string[] } {
  if (!isObject(patch)) throw new Error("invalid execution journal update");
  if (Object.hasOwn(patch, "result") && !isJsonSafe(patch.result)) throw new Error("invalid execution journal update");
  if (Object.hasOwn(patch, "phase") && !isPhase(patch.phase)) throw new Error("invalid execution journal update");
  if (Object.hasOwn(patch, "mutationCount") && (!Number.isSafeInteger(patch.mutationCount) || (patch.mutationCount as number) < 0)) throw new Error("invalid execution journal update");
  if (Object.hasOwn(patch, "message") && typeof patch.message !== "string") throw new Error("invalid execution journal update");
  if (includeTimestamps && Object.hasOwn(patch, "mutationTimestamps") && (!Array.isArray(patch.mutationTimestamps) || !patch.mutationTimestamps.every(isIsoTimestamp))) throw new Error("invalid execution journal update");
  return patch as JournalUpdate & { mutationTimestamps?: string[] };
}
function assertTransition(previous: JournalRecord, next: JournalRecord): void {
  const allowed = previous.phase === next.phase ||
    (previous.phase === "reserved" && (next.phase === "dispatched" || next.phase === "failed")) ||
    (previous.phase === "dispatched" && ["succeeded", "failed", "uncertain"].includes(next.phase)) ||
    (previous.phase === "uncertain" && ["succeeded", "failed"].includes(next.phase));
  if (!allowed || next.mutationCount < previous.mutationCount || !next.mutationTimestamps.every((value, index) => previous.mutationTimestamps[index] === value)) throw new Error("invalid execution journal transition");
}
function unchangedTerminal(record: JournalRecord, patch: JournalUpdate & { mutationTimestamps?: string[] }): boolean {
  return (!Object.hasOwn(patch, "phase") || patch.phase === record.phase) && (!Object.hasOwn(patch, "mutationCount") || patch.mutationCount === record.mutationCount) && (!Object.hasOwn(patch, "mutationTimestamps") || isDeepStrictEqual(patch.mutationTimestamps, record.mutationTimestamps)) && (!Object.hasOwn(patch, "result") || isDeepStrictEqual(patch.result, record.result)) && (!Object.hasOwn(patch, "message") || patch.message === record.message);
}
function isPhase(value: unknown): value is JournalPhase { return ["reserved", "dispatched", "succeeded", "failed", "uncertain"].includes(value as string); }
function isIsoTimestamp(value: unknown): value is string { return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
function isJsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value) ? value.every((item) => isJsonSafe(item, seen)) : isObject(value) && Object.values(value).every((item) => isJsonSafe(item, seen));
  seen.delete(value);
  return valid;
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function canonicalJson(value: unknown): string { return JSON.stringify(value, Object.keys((value ?? {}) as object).sort()); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function isAlreadyExists(error: unknown): boolean { return isNodeError(error) && (error.code === "EEXIST" || error.code === "EISDIR"); }
function isNotFound(error: unknown): boolean { return isNodeError(error) && error.code === "ENOENT"; }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
async function fsLink(from: string, to: string): Promise<void> { const { link } = await import("node:fs/promises"); await link(from, to); }
