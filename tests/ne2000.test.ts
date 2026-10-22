import { describe, expect, it } from 'vitest';
import { Ne2000 } from '../src/net/ne2000';

const MAC = new Uint8Array([0x52, 0x54, 0x00, 0xab, 0xcd, 0xef]);

/** A card set up the way NE2000 drivers do: word mode, ring 46h-80h, our address, started. */
function startedCard(): { nic: Ne2000; sent: Uint8Array[]; irq: () => boolean } {
  const nic = new Ne2000(MAC);
  const sent: Uint8Array[] = [];
  let irq = false;
  nic.onTransmit = (frame) => sent.push(frame);
  nic.onIrq = (level) => (irq = level);
  nic.write(0x00, 0x21); // page 0, stop, abort DMA
  nic.write(0x0e, 0x49); // word transfers
  nic.write(0x01, 0x46); // ring start
  nic.write(0x02, 0x80); // ring stop
  nic.write(0x03, 0x46); // boundary
  nic.write(0x0c, 0x04); // accept broadcasts
  nic.write(0x0f, 0xff); // all interrupts
  nic.write(0x07, 0xff);
  nic.write(0x00, 0x61); // page 1
  MAC.forEach((byte, i) => nic.write(1 + i, byte));
  nic.write(0x07, 0x47); // current page
  nic.write(0x00, 0x22); // page 0, start
  return { nic, sent, irq: () => irq };
}

/** Copies `bytes` from the card's memory at `address` by remote DMA. */
function remoteRead(nic: Ne2000, address: number, bytes: number): Uint8Array {
  nic.write(0x08, address & 0xff);
  nic.write(0x09, address >> 8);
  nic.write(0x0a, bytes & 0xff);
  nic.write(0x0b, bytes >> 8);
  nic.write(0x00, 0x0a);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 2) {
    const word = nic.readData(2);
    out[i] = word & 0xff;
    if (i + 1 < bytes) out[i + 1] = word >> 8;
  }
  return out;
}

describe('NE2000 network card', () => {
  it('shows its address in the PROM, each byte doubled, with the word-mode signature', () => {
    const { nic } = startedCard();
    const prom = remoteRead(nic, 0, 32);
    expect([...prom.subarray(0, 12)]).toEqual([...MAC].flatMap((byte) => [byte, byte]));
    expect(prom[28]).toBe(0x57);
    expect(nic.read(0x0a)).toBe(0x50);
    expect(nic.read(0x0b)).toBe(0x43);
  });

  it('sends a frame written to its memory', () => {
    const { nic, sent, irq } = startedCard();
    const frame = Uint8Array.from({ length: 64 }, (_, i) => i);
    nic.write(0x08, 0x00);
    nic.write(0x09, 0x40);
    nic.write(0x0a, frame.length);
    nic.write(0x0b, 0);
    nic.write(0x00, 0x12);
    for (let i = 0; i < frame.length; i += 2) nic.writeData(frame[i] | (frame[i + 1] << 8), 2);
    nic.write(0x07, 0xff);
    nic.write(0x04, 0x40);
    nic.write(0x05, frame.length);
    nic.write(0x06, 0);
    nic.write(0x00, 0x26);
    expect(sent).toHaveLength(1);
    expect([...sent[0]]).toEqual([...frame]);
    expect(nic.read(0x07) & 0x02).toBe(0x02);
    expect(irq()).toBe(true);
  });

  it('receives frames for its address and broadcasts into the ring, and ignores others', () => {
    const { nic, irq } = startedCard();
    const frame = new Uint8Array(100);
    frame.set(MAC);
    frame.fill(0x5a, 14);
    nic.receive(frame);
    expect(irq()).toBe(true);
    expect(nic.read(0x07) & 0x01).toBe(0x01);
    const header = remoteRead(nic, 0x4700, 4);
    expect(header[0] & 0x01).toBe(0x01);
    expect(header[1]).toBe(0x48);
    expect(header[2] | (header[3] << 8)).toBe(104);
    expect([...remoteRead(nic, 0x4704, 100)]).toEqual([...frame]);

    const broadcast = new Uint8Array(60).fill(0xff, 0, 6);
    nic.receive(broadcast);
    nic.write(0x00, 0x62);
    expect(nic.read(0x07)).toBe(0x49);
    nic.write(0x00, 0x22);

    const other = new Uint8Array(60);
    other.set([0x52, 0x54, 0x00, 1, 2, 3]);
    nic.receive(other);
    nic.write(0x00, 0x62);
    expect(nic.read(0x07)).toBe(0x49);
  });
});
