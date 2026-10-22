import type { Clock } from './pit';

const STATUS_OUTPUT_FULL = 0x01;
const STATUS_SYSTEM = 0x04;
const STATUS_COMMAND = 0x08;
const STATUS_UNLOCKED = 0x10;
const STATUS_AUX = 0x20;
const CMD_KBD_IRQ = 0x01;
const CMD_AUX_IRQ = 0x02;
const CMD_SYSTEM = 0x04;
const CMD_KBD_DISABLED = 0x10;
const CMD_AUX_DISABLED = 0x20;
const CMD_TRANSLATE = 0x40;
/** A byte becomes readable this long after the previous one was read, so drivers see them one interrupt at a time. */
const BYTE_DELAY_NS = 50_000;

/** Set 1 scancodes for KeyboardEvent.code (0xE0xx for extended keys). */
export const SCANCODES: Record<string, number> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08,
  Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10,
  KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20,
  KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28,
  Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30,
  KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37,
  AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41,
  F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49,
  NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50,
  Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
  NumpadEnter: 0xe01c, ControlRight: 0xe01d, NumpadDivide: 0xe035, PrintScreen: 0xe037, AltRight: 0xe038,
  Home: 0xe047, ArrowUp: 0xe048, PageUp: 0xe049, ArrowLeft: 0xe04b, ArrowRight: 0xe04d, End: 0xe04f,
  ArrowDown: 0xe050, PageDown: 0xe051, Insert: 0xe052, Delete: 0xe053, MetaLeft: 0xe05b, MetaRight: 0xe05c,
  ContextMenu: 0xe05d,
};

/** Set 1 to set 2 make codes, for a guest that turns translation off. */
const SET1_TO_SET2 = [
  0x00, 0x76, 0x16, 0x1e, 0x26, 0x25, 0x2e, 0x36, 0x3d, 0x3e, 0x46, 0x45, 0x4e, 0x55, 0x66, 0x0d, 0x15, 0x1d, 0x24,
  0x2d, 0x2c, 0x35, 0x3c, 0x43, 0x44, 0x4d, 0x54, 0x5b, 0x5a, 0x14, 0x1c, 0x1b, 0x23, 0x2b, 0x34, 0x33, 0x3b, 0x42,
  0x4b, 0x4c, 0x52, 0x0e, 0x12, 0x5d, 0x1a, 0x22, 0x21, 0x2a, 0x32, 0x31, 0x3a, 0x41, 0x49, 0x4a, 0x59, 0x7c, 0x11,
  0x29, 0x58, 0x05, 0x06, 0x04, 0x0c, 0x03, 0x0b, 0x83, 0x0a, 0x01, 0x09, 0x77, 0x7e, 0x6c, 0x75, 0x7d, 0x7b, 0x6b,
  0x73, 0x74, 0x79, 0x69, 0x72, 0x7a, 0x70, 0x71, 0x00, 0x00, 0x61, 0x78, 0x07,
];

/**
 * The 8042 keyboard controller with a PS/2 keyboard (scancode set 1 through
 * the controller's translation, or set 2 without it) and a PS/2 mouse with
 * a wheel (IntelliMouse). It also owns the A20 gate and the CPU reset line
 * of its output port.
 */
export class I8042 {
  status = STATUS_SYSTEM | STATUS_UNLOCKED;
  command = CMD_KBD_IRQ | CMD_SYSTEM | CMD_TRANSLATE;
  private output = 0;
  private outputFromAux = false;
  private readonly kbdQueue: number[] = [];
  private readonly auxQueue: number[] = [];
  private readyAt = 0;
  /** A controller command waiting for its data byte (0 for none). */
  private pendingCommand = 0;
  /** A keyboard command waiting for its data byte. */
  private kbdCommand = 0;
  private kbdScanning = true;
  private kbdSet = 2;
  // The mouse.
  private auxCommand = 0;
  private auxEnabled = false;
  private auxRate = 100;
  private auxResolution = 2;
  private auxScaling = false;
  private auxWrap = false;
  private auxRemote = false;
  private auxRates: number[] = [];
  /** 0 for a plain PS/2 mouse, 3 for an IntelliMouse (wheel). */
  private auxId = 0;
  private buttons = 0;
  private dx = 0;
  private dy = 0;
  private dz = 0;
  outputPort = 0xcf;
  onIrq1: (level: boolean) => void = () => {};
  onIrq12: (level: boolean) => void = () => {};
  onA20: (enabled: boolean) => void = () => {};
  onReset: () => void = () => {};

  constructor(private readonly clock: Clock) {}

  reset(): void {
    this.status = STATUS_SYSTEM | STATUS_UNLOCKED;
    this.command = CMD_KBD_IRQ | CMD_SYSTEM | CMD_TRANSLATE;
    this.kbdQueue.length = this.auxQueue.length = 0;
    this.pendingCommand = this.kbdCommand = this.auxCommand = 0;
    this.kbdScanning = true;
    this.kbdSet = 2;
    this.auxEnabled = false;
    this.auxId = 0;
    this.auxRates = [];
    this.dx = this.dy = this.dz = 0;
    this.outputPort = 0xcf;
    this.onIrq1(false);
    this.onIrq12(false);
  }

  // --- The host side -------------------------------------------------------------------

  /** A key went down or up (`code` from SCANCODES). */
  key(code: number, down: boolean): void {
    if (!this.kbdScanning) return;
    const bytes: number[] = [];
    if (code > 0xff) bytes.push(0xe0);
    const make = code & 0xff;
    if (this.kbdSet === 2 && !(this.command & CMD_TRANSLATE)) {
      bytes.push(...(down ? [] : [0xf0]), SET1_TO_SET2[make] ?? make);
    } else {
      bytes.push(down ? make : make | 0x80);
    }
    this.kbdQueue.push(...bytes);
    this.pump();
  }

  /** Mouse movement (x right, y down, z wheel down) and buttons (bit 0 left, 1 right, 2 middle). */
  mouse(dx: number, dy: number, dz: number, buttons: number): void {
    this.dx += dx;
    this.dy += dy;
    this.dz += dz;
    const changed = buttons !== this.buttons;
    this.buttons = buttons;
    if (this.auxEnabled && !this.auxRemote && (changed || this.dx || this.dy || this.dz) && this.auxQueue.length < 48) this.sendPacket();
  }

  private sendPacket(): void {
    const clamp = (v: number) => Math.max(-255, Math.min(255, v));
    const dx = clamp(this.dx);
    const dy = clamp(-this.dy);
    const dz = Math.max(-8, Math.min(7, this.dz));
    this.dx -= dx;
    this.dy += dy;
    this.dz -= dz;
    const b0 = 0x08 | (this.buttons & 7) | (dx < 0 ? 0x10 : 0) | (dy < 0 ? 0x20 : 0);
    this.auxQueue.push(b0, dx & 0xff, dy & 0xff);
    if (this.auxId === 3) this.auxQueue.push(dz & 0xff);
    this.pump();
  }

  // --- The controller ------------------------------------------------------------------

  /** Moves the next waiting byte into the output buffer once it's empty. */
  private pump(): void {
    if (this.status & STATUS_OUTPUT_FULL) return;
    if (this.clock.now() < this.readyAt) return;
    if (this.kbdQueue.length && !(this.command & CMD_KBD_DISABLED)) {
      this.fill(this.kbdQueue.shift()!, false);
    } else if (this.auxQueue.length && !(this.command & CMD_AUX_DISABLED)) {
      this.fill(this.auxQueue.shift()!, true);
    }
  }

  private fill(byte: number, aux: boolean): void {
    this.output = byte;
    this.outputFromAux = aux;
    this.status = (this.status & ~STATUS_AUX) | STATUS_OUTPUT_FULL | (aux ? STATUS_AUX : 0);
    if (aux) {
      if (this.command & CMD_AUX_IRQ) this.onIrq12(true);
    } else if (this.command & CMD_KBD_IRQ) {
      this.onIrq1(true);
    }
  }

  /** A controller reply goes straight into the output buffer (even with the keyboard disabled), ahead of the devices. */
  private reply(byte: number, aux = false): void {
    if (this.status & STATUS_OUTPUT_FULL) {
      (this.outputFromAux ? this.auxQueue : this.kbdQueue).unshift(this.output);
      if (this.outputFromAux) this.onIrq12(false);
      else this.onIrq1(false);
    }
    this.status &= ~STATUS_OUTPUT_FULL;
    this.fill(byte, aux);
  }

  /** When the next queued byte can be delivered, for the machine's scheduler. */
  get nextEvent(): number {
    if (this.status & STATUS_OUTPUT_FULL || (!this.kbdQueue.length && !this.auxQueue.length)) return Infinity;
    return this.readyAt;
  }

  update(): void {
    this.pump();
  }

  readData(): number {
    const value = this.output;
    if (this.status & STATUS_OUTPUT_FULL) {
      this.status &= ~(STATUS_OUTPUT_FULL | STATUS_AUX);
      if (this.outputFromAux) this.onIrq12(false);
      else this.onIrq1(false);
      this.readyAt = this.clock.now() + BYTE_DELAY_NS;
    }
    return value;
  }

  readStatus(): number {
    this.pump();
    return this.status;
  }

  writeData(value: number): void {
    this.status &= ~STATUS_COMMAND;
    const command = this.pendingCommand;
    this.pendingCommand = 0;
    switch (command) {
      case 0x60:
        this.command = value;
        this.status = (this.status & ~STATUS_SYSTEM) | (value & CMD_SYSTEM ? STATUS_SYSTEM : 0);
        this.pump();
        return;
      case 0xd1:
        this.writeOutputPort(value);
        return;
      case 0xd2:
        this.reply(value);
        return;
      case 0xd3:
        this.reply(value, true);
        return;
      case 0xd4:
        this.auxWrite(value);
        return;
      default:
        this.command &= ~CMD_KBD_DISABLED;
        this.kbdWrite(value);
    }
  }

  writeCommand(value: number): void {
    this.status |= STATUS_COMMAND;
    switch (value) {
      case 0x20:
        this.reply(this.command);
        return;
      case 0x60:
      case 0xd1:
      case 0xd2:
      case 0xd3:
      case 0xd4:
        this.pendingCommand = value;
        return;
      case 0xa7:
        this.command |= CMD_AUX_DISABLED;
        return;
      case 0xa8:
        this.command &= ~CMD_AUX_DISABLED;
        this.pump();
        return;
      case 0xa9:
        this.reply(0);
        return;
      case 0xaa:
        this.status |= STATUS_SYSTEM;
        this.reply(0x55);
        return;
      case 0xab:
        this.reply(0);
        return;
      case 0xad:
        this.command |= CMD_KBD_DISABLED;
        return;
      case 0xae:
        this.command &= ~CMD_KBD_DISABLED;
        this.pump();
        return;
      case 0xc0:
        this.reply(0x80);
        return;
      case 0xd0:
        this.reply(this.outputPort);
        return;
      case 0xdd:
        this.onA20(false);
        return;
      case 0xdf:
        this.onA20(true);
        return;
      default:
        // Pulse output port lines: bit 0 is the CPU reset.
        if (value >= 0xf0 && !(value & 1)) this.onReset();
    }
  }

  private writeOutputPort(value: number): void {
    this.outputPort = value;
    this.onA20((value & 2) !== 0);
    if (!(value & 1)) this.onReset();
  }

  // --- The keyboard ----------------------------------------------------------------------

  private kbdWrite(value: number): void {
    const command = this.kbdCommand;
    if (command) {
      this.kbdCommand = 0;
      if (command === 0xf0) {
        if (value === 0) {
          this.kbdQueue.push(0xfa, this.kbdSet);
        } else {
          if (value <= 3) this.kbdSet = value;
          this.kbdQueue.push(0xfa);
        }
      } else {
        // LEDs, typematic rate: acknowledged.
        this.kbdQueue.push(0xfa);
      }
      this.pump();
      return;
    }
    switch (value) {
      case 0xed:
      case 0xf3:
      case 0xf0:
        this.kbdCommand = value;
        this.kbdQueue.push(0xfa);
        break;
      case 0xee:
        this.kbdQueue.push(0xee);
        break;
      case 0xf2:
        this.kbdQueue.push(0xfa, 0xab, 0x83);
        break;
      case 0xf4:
        this.kbdScanning = true;
        this.kbdQueue.push(0xfa);
        break;
      case 0xf5:
        this.kbdScanning = false;
        this.kbdQueue.push(0xfa);
        break;
      case 0xf6:
        this.kbdScanning = true;
        this.kbdQueue.push(0xfa);
        break;
      case 0xff:
        this.kbdQueue.length = 0;
        this.kbdScanning = true;
        this.kbdSet = 2;
        this.kbdQueue.push(0xfa, 0xaa);
        break;
      default:
        this.kbdQueue.push(0xfa);
    }
    this.pump();
  }

  // --- The mouse -------------------------------------------------------------------------

  private auxWrite(value: number): void {
    const q = this.auxQueue;
    if (this.auxWrap && value !== 0xec && value !== 0xff) {
      q.push(value);
      this.pump();
      return;
    }
    const command = this.auxCommand;
    if (command) {
      this.auxCommand = 0;
      if (command === 0xf3) {
        this.auxRate = value;
        this.auxRates = [...this.auxRates, value].slice(-3);
        if (this.auxRates.join() === '200,100,80') this.auxId = 3;
      } else if (command === 0xe8) {
        this.auxResolution = value & 3;
      }
      q.push(0xfa);
      this.pump();
      return;
    }
    switch (value) {
      case 0xe6:
      case 0xe7:
        this.auxScaling = value === 0xe7;
        q.push(0xfa);
        break;
      case 0xe8:
      case 0xf3:
        this.auxCommand = value;
        q.push(0xfa);
        break;
      case 0xe9:
        q.push(0xfa, (this.auxRemote ? 0x40 : 0) | (this.auxEnabled ? 0x20 : 0) | (this.auxScaling ? 0x10 : 0) | (this.buttons & 7), this.auxResolution, this.auxRate);
        break;
      case 0xea:
        this.auxRemote = false;
        q.push(0xfa);
        break;
      case 0xeb:
        q.push(0xfa);
        this.sendPacket();
        break;
      case 0xec:
        this.auxWrap = false;
        q.push(0xfa);
        break;
      case 0xee:
        this.auxWrap = true;
        q.push(0xfa);
        break;
      case 0xf0:
        this.auxRemote = true;
        q.push(0xfa);
        break;
      case 0xf2:
        q.push(0xfa, this.auxId);
        break;
      case 0xf4:
        this.auxEnabled = true;
        q.push(0xfa);
        break;
      case 0xf5:
        this.auxEnabled = false;
        q.push(0xfa);
        break;
      case 0xf6:
        this.auxRate = 100;
        this.auxResolution = 2;
        this.auxScaling = false;
        q.push(0xfa);
        break;
      case 0xff:
        q.length = 0;
        this.auxEnabled = false;
        this.auxRemote = this.auxWrap = false;
        this.auxId = 0;
        this.auxRates = [];
        this.auxRate = 100;
        this.auxResolution = 2;
        q.push(0xfa, 0xaa, 0x00);
        break;
      default:
        q.push(0xfa);
    }
    this.pump();
  }
}
