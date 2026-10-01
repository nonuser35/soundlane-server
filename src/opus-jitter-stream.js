import { Readable } from "node:stream";

const SILENCE_PACKET = Buffer.from([0xf8, 0xff, 0xfe]);

export class OpusJitterStream extends Readable {
  constructor({ targetPackets = 6, maxPackets = 30 } = {}) {
    super({ objectMode: false, highWaterMark: 64 * 1024 });
    this.targetPackets = targetPackets;
    this.maxPackets = maxPackets;
    this.queue = [];
    this.started = false;
    this.ended = false;
    this.backpressured = false;
    this.expectedSequence = null;
    this.underruns = 0;
    this.droppedPackets = 0;
    this.lostPackets = 0;
    this.timer = null;
  }

  addPacket(sequence, payload) {
    if (this.ended || this.destroyed) return;

    if (this.expectedSequence !== null && sequence > this.expectedSequence) {
      this.lostPackets += sequence - this.expectedSequence;
    }
    this.expectedSequence = sequence + 1;
    this.queue.push(Buffer.from(payload));

    if (this.queue.length > this.maxPackets) {
      const dropCount = this.queue.length - this.targetPackets;
      this.queue.splice(0, dropCount);
      this.droppedPackets += dropCount;
    }

    if (!this.started && this.queue.length >= this.targetPackets) {
      this.started = true;
      this.timer = setInterval(() => this.tick(), 20);
      this.timer.unref();
      this.tick();
    }
  }

  tick() {
    if (this.destroyed || this.backpressured) return;
    if (this.ended && this.queue.length === 0) {
      this.stopTimer();
      this.push(null);
      return;
    }

    let packet = this.queue.shift();
    if (!packet) {
      packet = SILENCE_PACKET;
      this.underruns += 1;
    }
    this.backpressured = !this.push(packet);
  }

  endInput() {
    this.ended = true;
    if (!this.started || this.queue.length === 0) {
      this.stopTimer();
      this.push(null);
    }
  }

  diagnostics() {
    return {
      queuedPackets: this.queue.length,
      bufferedMs: this.queue.length * 20,
      underruns: this.underruns,
      droppedPackets: this.droppedPackets,
      lostPackets: this.lostPackets
    };
  }

  _read() {
    this.backpressured = false;
  }

  _destroy(error, callback) {
    this.stopTimer();
    callback(error);
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

