/** The disk the disk-format fixtures were made from: 4 MB, mostly empty, with patterned sectors at the start, in the middle and at the end. */
export function patternDisk(): Uint8Array {
  const disk = new Uint8Array(4 << 20);
  const sectors = disk.length / 512;
  const used = [...Array(16).keys(), ...Array.from({ length: 52 }, (_, i) => 2048 + i), sectors - 1];
  for (const sector of used) {
    for (let i = 0; i < 512; i++) disk[sector * 512 + i] = (sector * 7 + i) & 0xff;
  }
  return disk;
}
