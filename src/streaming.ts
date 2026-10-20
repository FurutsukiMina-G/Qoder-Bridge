import type { Decision } from './compat.js';
import {isLeakedFinalProtocol,mayStartToolProtocol} from './protocol-text.js';

/** Project only the unambiguous final.content JSON string. Tool decisions stay buffered. */
export class FinalTextProjector {
  private source = '';
  private at: number | null = null;
  private closed = false;
  private broken = false;
  private decoded = '';
  emitted = '';
  constructor(private readonly send: (text: string) => void) {}
  /** A rejected tool decision was never published; discard only its private parser buffer. */
  resetUncommitted() {
    if (this.emitted) return false;
    this.source = ''; this.at = null; this.closed = false; this.broken = false; this.decoded = '';
    return true;
  }
  push(delta: string) {
    this.source += delta;
    if (this.broken || this.closed) return;
    if (this.at === null) {
      const start = /^\s*(?:```json\s*)?\{\s*"kind"\s*:\s*"final"\s*,\s*"content"\s*:\s*"/.exec(this.source);
      if (!start) return;
      this.at = start[0].length;
    }
    while (this.at < this.source.length) {
      const char = this.source[this.at]!;
      if (char === '"') { this.closed = true; this.at++; break; }
      if (char !== '\\') { this.decoded += char; this.at++; continue; }
      if (this.at + 1 >= this.source.length) break;
      const escape = this.source[this.at + 1]!;
      if (escape === 'u') {
        if (this.at + 6 > this.source.length) break;
        const hex = this.source.slice(this.at + 2, this.at + 6);
        if (!/^[0-9a-f]{4}$/i.test(hex)) { this.broken = true; break; }
        this.decoded += String.fromCharCode(parseInt(hex, 16)); this.at += 6;
      } else {
        const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        if (!(escape in escapes)) { this.broken = true; break; }
        this.decoded += escapes[escape]; this.at += 2;
      }
    }
    let text = this.decoded;
    // Do not leak a call envelope that the model incorrectly wrapped in final.content.
    if (!this.emitted && (isLeakedFinalProtocol(text) || (!this.closed && mayStartToolProtocol(text)))) return;
    // Never split a UTF-16 surrogate pair across transport chunks.
    if (!this.closed && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    const next = text.slice(this.emitted.length);
    if (next) { this.send(next); this.emitted = text; }
  }
  validate(decision: Decision) {
    if (decision.kind === 'final' && isLeakedFinalProtocol(decision.content))
      throw new Error('Tool protocol was returned as final text');
    if (this.emitted && (decision.kind !== 'final' || !decision.content.startsWith(this.emitted)))
      throw new Error('Streamed answer does not match the validated model decision');
  }
  finish(decision: Decision) {
    this.validate(decision);
    if (decision.kind === 'final') {
      const tail = decision.content.slice(this.emitted.length);
      if (tail) this.send(tail);
      this.emitted = decision.content;
    }
  }
}
