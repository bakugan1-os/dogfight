// Token bucket (Lab 4, M4): a bucket holds up to `burst` tokens and refills at `perSecond`.
// Every message costs one token; an empty bucket means "too fast". Short bursts are fine
// (typing three chat lines quickly), a sustained flood is not.

export class TokenBucket {
  #tokens;
  #last;

  constructor({ perSecond, burst, now = () => performance.now() }) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.now = now;
    this.#tokens = burst;
    this.#last = now();
  }

  /** @returns {boolean} true if a token was available (and is now spent) */
  take(cost = 1) {
    const t = this.now();
    this.#tokens = Math.min(this.burst, this.#tokens + ((t - this.#last) / 1000) * this.perSecond);
    this.#last = t;
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }

  get tokens() {
    return this.#tokens;
  }
}
