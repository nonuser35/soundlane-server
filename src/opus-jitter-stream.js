import { Readable } from "node:stream";

export class OpusJitterStream extends Readable {
  constructor({ targetPackets = 6, maxPackets = 30 } = {}) {
    super({ objectMode: true, highWaterMark: targetPackets });
    this.targetPackets = targetPackets;
    this.maxPackets = maxPackets;
    this.queue = [];
    this.started = false;
    this.ended = false;
    this.backpressured = false;
    this.expectedSequence = null;
    this.droppedPackets = 0;
    this.lostPackets = 0;
  }

  addPacket(sequence, payload) {
    if (this.ended || this.destroyed) return;

    if (this.expectedSequence !== null && sequence > this.expectedSequence) {
      this.lostPackets += sequence - this.expectedSequence;
    }
    this.expectedSequence = sequence + 1;
    if (this.readableLength + this.queue.length >= this.maxPackets) {
      if (this.queue.length > 0) this.queue.shift();
      else {
        this.droppedPackets += 1;
        return;
      }
      this.droppedPackets += 1;
    }
    this.queue.push(Buffer.from(payload));

    if (!this.started && this.queue.length >= this.targetPackets) {
      this.started = true;
      this.flushQueue();
    } else if (this.started) {
      this.flushQueue();
    }
  }

  flushQueue() {
    if (this.destroyed || this.backpressured || !this.started) return;
    while (this.queue.length > 0 && !this.backpressured) {
      this.backpressured = !this.push(this.queue.shift());
    }
    if (this.ended && this.queue.length === 0) this.push(null);
  }

  endInput() {
    this.ended = true;
    this.started = true;
    this.flushQueue();
  }

  diagnostics() {
    return {
      queuedPackets: this.readableLength + this.queue.length,
      bufferedMs: (this.readableLength + this.queue.length) * 20,
      droppedPackets: this.droppedPackets,
      lostPackets: this.lostPackets
    };
  }

  _read() {
    this.backpressured = false;
    this.flushQueue();
  }

  _destroy(error, callback) {
    callback(error);
  }
}

