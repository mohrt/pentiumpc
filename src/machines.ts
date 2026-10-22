import type { MachineConfig } from './pc';

export type MachineId = 'dos' | 'win95' | 'win98';

/** A starting point for the machine setup: the same PC, set up the way each system wants it. */
export interface MachinePreset {
  id: MachineId;
  name: string;
  /** Shown under the choice in machine setup. */
  description: string;
  config: MachineConfig;
  /** The size offered for a new hard disk, in megabytes. */
  newDiskMb: number;
}

export const MACHINES: Record<MachineId, MachinePreset> = {
  dos: {
    id: 'dos',
    name: 'DOS and Windows 3.1',
    description:
      'A 16 MB PC that boots from the floppy drive first, for installing DOS from its disks (MS-DOS, PC DOS or FreeDOS) and Windows 3.1 on top. A 500 MB disk is plenty, and within what DOS partitions allow.',
    config: { memoryMb: 16, bootOrder: ['floppy', 'hd', 'cdrom'] },
    newDiskMb: 500,
  },
  win95: {
    id: 'win95',
    name: 'Windows 95',
    description:
      'A 32 MB PC that boots from the floppy drive first, since Windows 95 setup starts from a boot disk (its CD is not bootable). A 500 MB disk suits the original release (FAT16 partitions stop at 2 GB).',
    config: { memoryMb: 32, bootOrder: ['floppy', 'hd', 'cdrom'] },
    newDiskMb: 500,
  },
  win98: {
    id: 'win98',
    name: 'Windows 98',
    description:
      'A 64 MB PC that boots from the hard disk, then the CD-ROM: a blank disk falls through to the Windows 98 CD, and once Windows is installed it starts on its own.',
    config: { memoryMb: 64, bootOrder: ['hd', 'cdrom', 'floppy'] },
    newDiskMb: 2000,
  },
};

export const DEFAULT_MACHINE: MachineId = 'win98';
