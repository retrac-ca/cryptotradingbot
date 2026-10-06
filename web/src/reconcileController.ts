/**
 * ReconcileController — serializes explicit reconciliation requests.
 *
 * The dashboard treats reconciliation as a deliberate, read-only operation:
 *   - it is never polled automatically;
 *   - at most one request is in flight at any time (overlapping requests are
 *     ignored, not queued or retried);
 *   - callers can observe `isPending` to disable the request control.
 */

export class ReconcileController {
  private pending = false;

  constructor(private readonly run: () => Promise<void>) {}

  get isPending(): boolean {
    return this.pending;
  }

  /**
   * Request reconciliation. Returns `true` if this call started a request,
   * `false` if one was already in flight (the request is ignored).
   */
  async request(): Promise<boolean> {
    if (this.pending) return false;
    this.pending = true;
    try {
      await this.run();
      return true;
    } finally {
      this.pending = false;
    }
  }
}
