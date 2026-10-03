class SoundlaneRelayPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.port.onmessage = event => {
      if (event.data?.type === 'clear') { this.queue = []; this.offset = 0; return; }
      if (event.data instanceof ArrayBuffer) this.queue.push(new Float32Array(event.data));
    };
  }
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output?.length) return true;
    for (let frame = 0; frame < output[0].length; frame += 1) {
      while (this.queue.length && this.offset >= this.queue[0].length) { this.queue.shift(); this.offset = 0; }
      const chunk = this.queue[0];
      output[0][frame] = chunk ? chunk[this.offset] || 0 : 0;
      if (output[1]) output[1][frame] = chunk ? chunk[this.offset + 1] || 0 : output[0][frame];
      if (chunk) this.offset += 2;
    }
    return true;
  }
}
registerProcessor('soundlane-relay-player', SoundlaneRelayPlayer);
