import { SCANCODES, type I8042 } from '../chips/i8042';

/** Keys that are left to the browser even while the PC has the keyboard. */
const BROWSER_KEYS = new Set(['F11']);

/**
 * The browser's keyboard and mouse as the PC's PS/2 keyboard and mouse. Keys
 * go to the PC while the screen has focus; clicking the screen captures the
 * mouse (pointer lock), and Esc (which the browser keeps for itself) lets it go.
 */
export class BrowserInput {
  private readonly down = new Set<string>();
  private buttons = 0;
  /** Called when the mouse is captured or let go. */
  onMouseCapture: (captured: boolean) => void = () => {};

  constructor(
    private readonly kbc: () => I8042,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  get mouseCaptured(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  attach(target: Window): void {
    this.canvas.addEventListener('keydown', (event) => this.key(event, true));
    this.canvas.addEventListener('keyup', (event) => this.key(event, false));
    this.canvas.addEventListener('blur', () => this.releaseAll());
    this.canvas.addEventListener('mousedown', (event) => {
      if (!this.mouseCaptured) {
        void this.canvas.requestPointerLock();
        return;
      }
      this.setButton(event.button, true);
      event.preventDefault();
    });
    target.addEventListener('mouseup', (event) => {
      if (this.mouseCaptured) this.setButton(event.button, false);
    });
    target.addEventListener('mousemove', (event) => {
      if (this.mouseCaptured) this.kbc().mouse(event.movementX, event.movementY, 0, this.buttons);
    });
    this.canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.mouseCaptured) return;
        event.preventDefault();
        this.kbc().mouse(0, 0, Math.sign(event.deltaY), this.buttons);
      },
      { passive: false },
    );
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      if (!this.mouseCaptured && this.buttons) {
        this.buttons = 0;
        this.kbc().mouse(0, 0, 0, 0);
      }
      this.onMouseCapture(this.mouseCaptured);
    });
  }

  private key(event: KeyboardEvent, down: boolean): void {
    if (event.metaKey || BROWSER_KEYS.has(event.code)) return;
    const code = SCANCODES[event.code];
    if (code === undefined) return;
    event.preventDefault();
    if (down && event.repeat && this.down.has(event.code)) {
      this.kbc().key(code, true);
      return;
    }
    if (down) this.down.add(event.code);
    else if (!this.down.delete(event.code)) return;
    this.kbc().key(code, down);
  }

  /** Lets go of every key held, e.g. when the screen loses focus. */
  releaseAll(): void {
    for (const key of this.down) this.kbc().key(SCANCODES[key], false);
    this.down.clear();
  }

  /** Presses a key combination (such as Ctrl+Alt+Del, which the host keeps for itself) and lets it go. */
  pressCombination(codes: string[]): void {
    const kbc = this.kbc();
    for (const code of codes) kbc.key(SCANCODES[code], true);
    for (const code of [...codes].reverse()) kbc.key(SCANCODES[code], false);
  }

  private setButton(button: number, pressed: boolean): void {
    const bit = button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0;
    if (!bit) return;
    this.buttons = pressed ? this.buttons | bit : this.buttons & ~bit;
    this.kbc().mouse(0, 0, 0, this.buttons);
  }
}
