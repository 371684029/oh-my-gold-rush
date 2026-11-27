// GoldRush v2.6 — 外部数据源熔断器（纯函数状态机，零外部依赖）
// 避免 Yahoo / FRED / SPDR 等海外源连续超时时，每次采集或同步反复白等十余秒。

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** 触发熔断的连续失败次数阈值（默认 2） */
  failureThreshold?: number;
  /** 熔断冷却时长毫秒（默认 15 分钟） */
  cooldownMs?: number;
}

export interface SourceHealthSnapshot {
  source: string;
  state: CircuitState;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  cooldownRemainingSec: number;
}

interface InternalSourceRecord {
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  openedAtMs: number | null;
  lastError: string | null;
  lastFailureAtMs: number | null;
  lastSuccessAtMs: number | null;
}

export const DEFAULT_FAILURE_THRESHOLD = 2;
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;

export class SourceCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly records = new Map<string, InternalSourceRecord>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.cooldownMs = Math.max(1_000, options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  }

  private getOrCreate(source: string): InternalSourceRecord {
    const key = String(source || 'unknown').trim().toLowerCase();
    let rec = this.records.get(key);
    if (!rec) {
      rec = {
        consecutiveFailures: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        openedAtMs: null,
        lastError: null,
        lastFailureAtMs: null,
        lastSuccessAtMs: null,
      };
      this.records.set(key, rec);
    }
    return rec;
  }

  /** 查询当前熔断状态 */
  getState(source: string, nowMs: number = Date.now()): CircuitState {
    const key = String(source || 'unknown').trim().toLowerCase();
    const rec = this.records.get(key);
    if (!rec || rec.openedAtMs == null) return 'closed';
    if (nowMs - rec.openedAtMs >= this.cooldownMs) return 'half_open';
    return 'open';
  }

  /** 是否允许发起本次外部请求（open 冷却期内直接短路跳过） */
  canRequest(source: string, nowMs: number = Date.now()): boolean {
    return this.getState(source, nowMs) !== 'open';
  }

  /** 记录请求成功：立即重置连续失败计数并关闭熔断 */
  recordSuccess(source: string, nowMs: number = Date.now()): void {
    const rec = this.getOrCreate(source);
    rec.consecutiveFailures = 0;
    rec.totalSuccesses += 1;
    rec.openedAtMs = null;
    rec.lastSuccessAtMs = nowMs;
  }

  /** 记录请求失败：达到阈值或半开探测失败时进入 open 冷却期 */
  recordFailure(source: string, reason?: string, nowMs: number = Date.now()): void {
    const rec = this.getOrCreate(source);
    rec.consecutiveFailures += 1;
    rec.totalFailures += 1;
    rec.lastFailureAtMs = nowMs;
    rec.lastError = reason ? String(reason).slice(0, 160) : 'request_failed';
    if (rec.consecutiveFailures >= this.failureThreshold || rec.openedAtMs != null) {
      rec.openedAtMs = nowMs;
    }
  }

  /** 手动重置单个或全部数据源状态（供测试或人工强刷） */
  reset(source?: string): void {
    if (source) {
      this.records.delete(String(source).trim().toLowerCase());
    } else {
      this.records.clear();
    }
  }

  /** 导出所有已追踪数据源的健康快照 */
  getHealthSnapshot(nowMs: number = Date.now()): SourceHealthSnapshot[] {
    const out: SourceHealthSnapshot[] = [];
    for (const [source, rec] of this.records.entries()) {
      const state = this.getState(source, nowMs);
      const remainingMs = state === 'open' && rec.openedAtMs != null
        ? Math.max(0, this.cooldownMs - (nowMs - rec.openedAtMs))
        : 0;
      out.push({
        source,
        state,
        consecutiveFailures: rec.consecutiveFailures,
        totalFailures: rec.totalFailures,
        totalSuccesses: rec.totalSuccesses,
        lastError: rec.lastError,
        lastFailureAt: rec.lastFailureAtMs ? new Date(rec.lastFailureAtMs).toISOString() : null,
        lastSuccessAt: rec.lastSuccessAtMs ? new Date(rec.lastSuccessAtMs).toISOString() : null,
        cooldownRemainingSec: Math.ceil(remainingMs / 1000),
      });
    }
    return out.sort((a, b) => a.source.localeCompare(b.source));
  }

  /** 包装异步请求：熔断期直接返回 fallback，null/抛错计失败，非空值计成功 */
  async execute<T>(
    source: string,
    fn: () => Promise<T | null>,
    isValidResult: (val: T | null) => boolean = (v) => v != null,
    nowFn: () => number = () => Date.now(),
  ): Promise<{ value: T | null; skipped: boolean }> {
    const now = nowFn();
    if (!this.canRequest(source, now)) {
      return { value: null, skipped: true };
    }
    try {
      const val = await fn();
      if (isValidResult(val)) {
        this.recordSuccess(source, nowFn());
        return { value: val, skipped: false };
      }
      this.recordFailure(source, 'empty_or_invalid_response', nowFn());
      return { value: val, skipped: false };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordFailure(source, msg, nowFn());
      return { value: null, skipped: false };
    }
  }
}

const globalBreaker = new SourceCircuitBreaker();

export function getGlobalCircuitBreaker(): SourceCircuitBreaker {
  return globalBreaker;
}
