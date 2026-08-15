export interface ParallelTask<T> {
  id: string;
  fn: () => Promise<T>;
  providerKey?: string;
  estimatedTokens?: number;
}

export interface TaskResult<T> {
  id: string;
  success: boolean;
  result?: T;
  error?: string;
  durationMs: number;
}

export interface CoordinatorOptions {
  maxConcurrent: number;
  providerCooldownMs: number;
  timeoutMs: number;
}

const DEFAULT_OPTIONS: CoordinatorOptions = {
  maxConcurrent: 2,
  providerCooldownMs: 2000,
  timeoutMs: 60000,
};

/**
 * Coordinates parallel task execution with provider-aware rate limiting.
 * Serializes calls to the same provider while allowing cross-provider parallelism.
 */
export class ExecutionCoordinator {
  private options: CoordinatorOptions;
  private providerLastCall: Map<string, number> = new Map();
  private activeCount: number = 0;

  constructor(options?: Partial<CoordinatorOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Run parallel tasks with rate limit awareness.
   * Tasks sharing the same providerKey are serialized.
   * Tasks with different providerKeys can run concurrently (up to maxConcurrent).
   */
  async runParallel<T>(tasks: ParallelTask<T>[]): Promise<TaskResult<T>[]> {
    if (tasks.length === 0) return [];
    if (tasks.length === 1) {
      return [await this.runSingle(tasks[0])];
    }

    const results: TaskResult<T>[] = [];
    const queued = [...tasks];

    const runNext = async (): Promise<void> => {
      while (queued.length > 0) {
        if (this.activeCount >= this.options.maxConcurrent) {
          await new Promise(r => window.setTimeout(r, 50));
          continue;
        }

        const task = queued.shift()!;
        this.activeCount++;

        try {
          const result = await this.runWithProviderGate(task);
          results.push(result);
        } finally {
          this.activeCount--;
        }
      }
    };

    await runNext();
    return results;
  }

  /**
   * Run a single task with provider cooldown enforcement.
   */
  private async runSingle<T>(task: ParallelTask<T>): Promise<TaskResult<T>> {
    return this.runWithProviderGate(task);
  }

  /**
   * Enforce provider cooldown before executing a task.
   */
  private async runWithProviderGate<T>(task: ParallelTask<T>): Promise<TaskResult<T>> {
    const providerKey = task.providerKey ?? '__default__';
    const start = Date.now();

    // Wait for provider cooldown
    const lastCall = this.providerLastCall.get(providerKey) ?? 0;
    const elapsed = Date.now() - lastCall;
    if (elapsed < this.options.providerCooldownMs) {
      await new Promise(r => window.setTimeout(r, this.options.providerCooldownMs - elapsed));
    }

    this.providerLastCall.set(providerKey, Date.now());

    try {
      const result = await this.withTimeout(task.fn(), this.options.timeoutMs);
      return {
        id: task.id,
        success: true,
        result,
        durationMs: Date.now() - start,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        id: task.id,
        success: false,
        error: msg,
        durationMs: Date.now() - start,
      };
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(`Task timed out after ${ms}ms`)), ms);
      promise.then(
        (v) => { window.clearTimeout(timer); resolve(v); },
        (e) => { window.clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
      );
    });
  }
}

/**
 * Deduplicates search results by path, keeping the highest similarity score.
 */
export function deduplicateResults<T extends { path?: string; similarity?: number }>(
  results: T[],
): T[] {
  const seen = new Map<string, T>();
  for (const r of results) {
    const key = r.path ?? JSON.stringify(r);
    const existing = seen.get(key);
    if (!existing || (r.similarity ?? 0) > (existing.similarity ?? 0)) {
      seen.set(key, r);
    }
  }
  return Array.from(seen.values());
}

/**
 * Allocates token budget across parallel branches.
 * Returns the max tokens each branch can use.
 */
export function allocateTokenBudget(
  totalBudget: number,
  branchCount: number,
  reservedForSynthesis: number = 0.2,
): number {
  const available = totalBudget * (1 - reservedForSynthesis);
  return Math.floor(available / Math.max(branchCount, 1));
}

/**
 * Merges partial results from parallel branches, handling failures gracefully.
 */
export function mergePartialResults<T>(
  results: Array<{ id: string; success: boolean; result?: T; error?: string }>,
): { merged: T[]; failures: Array<{ id: string; error: string }> } {
  const merged: T[] = [];
  const failures: Array<{ id: string; error: string }> = [];

  for (const r of results) {
    if (r.success && r.result !== undefined) {
      merged.push(r.result);
    } else {
      failures.push({ id: r.id, error: r.error ?? 'Unknown error' });
    }
  }

  return { merged, failures };
}
