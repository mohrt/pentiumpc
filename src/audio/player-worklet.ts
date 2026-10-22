// Runs on the audio rendering thread. Plays chunks of stereo samples (interleaved left, right) posted by the emulator.

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

/** Start playing once this much audio is queued, so small hiccups don't cause gaps. */
const TARGET_LATENCY_SECONDS = 0.06;
/** If the emulator gets this far ahead of the speakers, drop audio back to the target. */
const MAX_LATENCY_SECONDS = 0.2;
/** How quickly the last sample fades to silence when the queue runs dry. */
const UNDERRUN_FADE = 0.995;

class SamplePlayer extends AudioWorkletProcessor {
  private readonly queue: Float32Array[] = [];
  /** Frames (left and right pairs) queued. */
  private queued = 0;
  /** Index into the first chunk (in samples, so always even). */
  private offset = 0;
  private buffering = true;
  private lastLeft = 0;
  private lastRight = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<Float32Array | 'flush'>) => {
      if (event.data === 'flush') {
        this.queue.length = 0;
        this.queued = this.offset = 0;
        this.buffering = true;
        return;
      }
      this.queue.push(event.data);
      this.queued += event.data.length / 2;
      if (this.queued > MAX_LATENCY_SECONDS * sampleRate) this.drop(this.queued - TARGET_LATENCY_SECONDS * sampleRate);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const left = channels[0];
    const right = channels[1] ?? left;
    if (this.buffering && this.queued >= TARGET_LATENCY_SECONDS * sampleRate) this.buffering = false;

    for (let i = 0; i < left.length; i++) {
      if (this.buffering || this.queue.length === 0) {
        this.buffering = true;
        this.lastLeft *= UNDERRUN_FADE;
        this.lastRight *= UNDERRUN_FADE;
        left[i] = this.lastLeft;
        right[i] = this.lastRight;
        continue;
      }
      const chunk = this.queue[0];
      this.lastLeft = chunk[this.offset++];
      this.lastRight = chunk[this.offset++];
      left[i] = this.lastLeft;
      right[i] = this.lastRight;
      this.queued--;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }

  private drop(frames: number): void {
    while (frames > 0 && this.queue.length > 0) {
      const available = (this.queue[0].length - this.offset) / 2;
      const take = Math.min(available, Math.ceil(frames));
      this.offset += take * 2;
      this.queued -= take;
      frames -= take;
      if (this.offset >= this.queue[0].length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
  }
}

registerProcessor('sample-player', SamplePlayer);
