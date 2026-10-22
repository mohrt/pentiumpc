export type RelayState = 'connecting' | 'connected' | 'disconnected';

/** Waits between reconnection attempts, growing to the last. */
const RETRY_MS = [1000, 2000, 5000, 10000, 30000];

/**
 * A connection to a network relay: a WebSocket server carrying one Ethernet
 * frame per binary message each way (the protocol of v86's relays, such as
 * websockproxy), which passes the PC's traffic on to the internet. Reconnects
 * when the connection drops.
 */
export class RelayConnection {
  private socket: WebSocket | null = null;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  state: RelayState = 'disconnected';
  /** Called with each frame from the relay. */
  onFrame: (frame: Uint8Array) => void = () => {};
  onState: (state: RelayState) => void = () => {};

  constructor(readonly url: string) {
    this.connect();
  }

  private setState(state: RelayState): void {
    this.state = state;
    this.onState(state);
  }

  private connect(): void {
    this.setState('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.retryLater();
      return;
    }
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      this.retries = 0;
      this.setState('connected');
    };
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) this.onFrame(new Uint8Array(event.data));
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.retryLater();
    };
    this.socket = socket;
  }

  private retryLater(): void {
    this.setState('disconnected');
    if (this.closed) return;
    const wait = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)];
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  /** Sends a frame from the PC (dropped while not connected, as on an unplugged cable). */
  send(frame: Uint8Array<ArrayBuffer>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.setState('disconnected');
  }
}
