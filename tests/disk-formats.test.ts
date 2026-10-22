import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { openDiskImage } from '../src/ide/disk-formats';
import { patternDisk } from './helpers/pattern-disk';

// The pattern disk, converted by qemu-img (scripts/make-disk-format-fixtures.ts).
const fixture = (name: string) => new Uint8Array(gunzipSync(readFileSync(join(__dirname, 'fixtures', 'disk-formats', `${name}.gz`))));

describe('hard disk image formats', () => {
  const original = patternDisk();

  it.each(['dynamic.vhd', 'fixed.vhd', 'sparse.vmdk', 'dynamic.vdi', 'static.vdi', 'v3.qcow2', 'v2.qcow2'])('unpacks %s to the disk it was made from', (name) => {
    const disk = openDiskImage(fixture(name));
    expect(disk.bytes.length).toBe(original.length);
    expect(Buffer.from(disk.bytes).equals(Buffer.from(original))).toBe(true);
  });

  it('takes anything else as a raw disk', () => {
    expect(Buffer.from(openDiskImage(original.slice()).bytes).equals(Buffer.from(original))).toBe(true);
  });

  it.each([
    ['compressed.qcow2', /qcow2 image is compressed.*qemu-img convert/],
    ['stream.vmdk', /VMDK is compressed.*qemu-img convert/],
  ])('explains that %s needs converting', (name, message) => {
    expect(() => openDiskImage(fixture(name))).toThrow(message);
  });

  it('explains that a VMDK descriptor needs its data file', () => {
    const descriptor = new TextEncoder().encode('# Disk DescriptorFile\nversion=1\ncreateType="monolithicFlat"\nRW 8192 FLAT "disk-flat.vmdk" 0\n');
    expect(() => openDiskImage(descriptor)).toThrow(/-flat\.vmdk file works as it is/);
  });
});
