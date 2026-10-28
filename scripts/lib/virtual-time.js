// Virtual clock + timers, so the responder's debounce runs instantly and
// deterministically in the tests and in the log replay.

class VirtualTime {
  constructor(start = 0) {
    this.current = start;
    this.timers = [];
  }

  now() {
    return this.current;
  }

  setTimeout(fn, ms) {
    this.timers.push({ at: this.current + ms, fn });
  }

  // Runs every timer due up to `time` (in order, awaiting each), then sets the clock
  async advanceTo(time) {
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > time) break;
      this.timers.shift();
      this.current = Math.max(this.current, next.at);
      await next.fn();
    }
    this.current = Math.max(this.current, time);
  }

  async advanceBy(ms) {
    await this.advanceTo(this.current + ms);
  }

  async runAll() {
    while (this.timers.length > 0) {
      await this.advanceTo(Math.max(...this.timers.map((t) => t.at)));
    }
  }
}

module.exports = { VirtualTime };
