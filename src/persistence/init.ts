/**
 * State initialization marker (Persistence & Restart Recovery).
 *
 * `.state/.init.json` records, per realm, whether the state directory has EVER
 * been initialized. It is the only way to distinguish a GENUINE first-ever
 * initialization from an EXISTING installation where a state file has
 * disappeared.
 *
 * Rules:
 *   - a domain file MISSING + marker ABSENT       -> genuine first-ever init;
 *   - a domain file MISSING + realm initialized  -> unexpected state loss -> HALT;
 *   - a domain file MISSING + realm NOT init     -> first init of that realm;
 *   - a corrupt/malformed/unsupported marker      -> HALT (never assume "not init").
 *
 * The marker is itself a versioned envelope (realm=`global`, domain=`state-init`)
 * and is written atomically, inside the same mutation lock as the state it
 * guards.
 */

import { readEnvelope, writeEnvelope } from './envelope.js';
import { CorruptStateError, type LoadResult } from './types.js';

export interface StateInitPayload {
  realms: { paper: boolean; live: boolean };
}

export class StateInitMarker {
  constructor(private readonly initPath: string) {}

  /** Load + validate the init marker (tri-state). */
  load(): LoadResult<StateInitPayload> {
    const r = readEnvelope(this.initPath, 'global', 'state-init');
    if (r.status !== 'OK') return r;
    const payload = r.data.payload as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { status: 'CORRUPT', reason: 'init marker payload is not an object' };
    }
    const realms = (payload as { realms?: unknown }).realms;
    if (!realms || typeof realms !== 'object' || Array.isArray(realms)) {
      return { status: 'CORRUPT', reason: 'init marker is missing its realms record' };
    }
    const rp = realms as { paper?: unknown; live?: unknown };
    if (typeof rp.paper !== 'boolean' || typeof rp.live !== 'boolean') {
      return { status: 'CORRUPT', reason: 'init marker realms must be booleans' };
    }
    return { status: 'OK', data: { realms: { paper: rp.paper, live: rp.live } } };
  }

  /** True when the realm has been initialized. Throws on a corrupt marker. */
  isInitialized(realm: 'paper' | 'live'): boolean {
    const r = this.load();
    if (r.status === 'CORRUPT') {
      throw new CorruptStateError(`state init marker is corrupt: ${r.reason}; operator must reconcile before starting`);
    }
    if (r.status === 'MISSING') return false;
    return r.data.realms[realm];
  }

  /**
   * Mark a realm as initialized (idempotent). Preserves the other realm's flag.
   * The caller must hold the state-directory mutation lock.
   */
  markInitialized(realm: 'paper' | 'live'): void {
    const current = this.load();
    if (current.status === 'CORRUPT') {
      throw new CorruptStateError(`state init marker is corrupt: ${current.reason}; cannot initialize`);
    }
    const realms: StateInitPayload['realms'] = { paper: false, live: false };
    if (current.status === 'OK') {
      realms.paper = current.data.realms.paper;
      realms.live = current.data.realms.live;
    }
    realms[realm] = true;
    writeEnvelope(this.initPath, 'global', 'state-init', { realms });
  }
}
