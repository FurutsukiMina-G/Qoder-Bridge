export function abortable<T>(pending: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** A released permit transfers directly to a waiter, so new arrivals cannot steal it. */
export class RequestSlots {
  active = 0;
  private waiters: Array<{ grant: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void }> = [];
  constructor(readonly limit: number) {}
  get queued() { return this.waiters.length; }
  async take(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve, reject) => {
      const waiter = { grant: resolve, reject, signal, abort: () => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(signal?.reason);
      } };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.signal?.removeEventListener('abort', next.abort);
        next.grant();
      } else this.active--;
    };
  }
}
