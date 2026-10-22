import './style.css';
import { trackMachineStarted } from './analytics';
import { FloppyImage } from './chips/fdc';
import { usableFilesInZip } from './drive/zip';
import { Emulator } from './emulator';
import { loadFirmware } from './firmware';
import { CdImage, CD_SECTOR_BYTES } from './ide/ide';
import { HARD_DISK_EXTENSIONS, openDiskImage } from './ide/disk-formats';
import { HardDiskImage } from './ide/image';
import { BrowserInput } from './io/browser-input';
import { DEFAULT_MACHINE, MACHINES, type MachineId } from './machines';
import { RelayConnection, type RelayState } from './net/relay';
import { Pc, type MachineConfig } from './pc';
import { Screen } from './render/screen';
import { HardDisks } from './storage/hard-disks';
import { memoryStores, openBrowserStores } from './storage/store';
import { downloadFile } from './ui/download';
import { attachDrives } from './ui/drives';
import { askForMachine, MEMORY_SIZES, relayProblem, type MachineChoices } from './ui/machine-setup';
import { JsonRecord } from './ui/settings';
import { attachToolbar } from './ui/toolbar';

/** The largest floppy image (2.88 MB); anything bigger is a CD or a hard disk. */
const MAX_FLOPPY_BYTES = 2949120;
/** How often changes to the hard disk are written to browser storage. */
const PERSIST_INTERVAL_MS = 5000;

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Page is missing ${selector}`);
  return element;
}

const sizeLabel = (bytes: number) => (bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : bytes >= 1 << 20 ? `${Math.round(bytes / (1 << 20))} MB` : `${Math.round(bytes / 1024)} KB`);

const statusLine = requireElement<HTMLElement>('#status');
const canvas = requireElement<HTMLCanvasElement>('#screen');
const screenFrame = requireElement<HTMLElement>('.screen-frame');
const setupPanel = requireElement<HTMLElement>('#machine-setup');
const mouseLabel = requireElement<HTMLElement>('.mouse-label');

function savedChoices(record: JsonRecord<MachineChoices>): MachineChoices {
  const saved = record.read();
  const machine = saved.machine && saved.machine in MACHINES ? saved.machine : DEFAULT_MACHINE;
  const memoryMb = saved.memoryMb && MEMORY_SIZES.includes(saved.memoryMb) ? saved.memoryMb : MACHINES[machine].config.memoryMb;
  const relayUrl = typeof saved.relayUrl === 'string' && !relayProblem(saved.relayUrl) ? saved.relayUrl : '';
  return { machine, memoryMb, relayUrl };
}

const machineConfig = (choices: MachineChoices): MachineConfig => ({ ...MACHINES[choices.machine].config, memoryMb: choices.memoryMb, network: choices.relayUrl !== '' });

/** The network card's MAC address: made up once (locally administered, in QEMU's 52:54:00 range) and kept. */
function networkAddress(): Uint8Array {
  const record = new JsonRecord<{ mac: number[] }>('pentiumpc-network');
  const saved = record.read().mac;
  if (Array.isArray(saved) && saved.length === 6 && saved.every((byte) => Number.isInteger(byte) && byte >= 0 && byte < 256)) return new Uint8Array(saved);
  const mac = new Uint8Array([0x52, 0x54, 0x00, 0, 0, 0]);
  crypto.getRandomValues(mac.subarray(3));
  record.write({ mac: [...mac] });
  return mac;
}

const NETWORK_STATES: Record<RelayState, string> = { connecting: 'network connecting', connected: 'network connected', disconnected: 'network relay not reachable' };

async function start(): Promise<void> {
  const machineRecord = new JsonRecord<MachineChoices>('pentiumpc-machine');
  const firstVisit = !machineRecord.read().machine;
  let choices = savedChoices(machineRecord);

  const openStores = openBrowserStores(() => (statusLine.textContent = 'Waiting for browser storage (close other tabs of this page)...')).catch(() => {
    statusLine.textContent = "This browser can't store the hard disk: it is lost when the page closes.";
    return memoryStores();
  });
  const [stores, firmware] = await Promise.all([openStores, loadFirmware(import.meta.env.BASE_URL)]);
  const hardDisks = new HardDisks(stores.hardDisks);

  const pc = new Pc(machineConfig(choices));
  // Interpreted for now: with translated blocks, Windows 98 hangs as it starts (a translation bug not yet found).
  pc.cpu.jitEnabled = false;
  pc.setFirmware(firmware.bios, firmware.vgaBios);
  pc.nic.mac.set(networkAddress());
  let relay: RelayConnection | null = null;
  pc.nic.onTransmit = (frame) => relay?.send(frame);
  const connectRelay = (url: string) => {
    if (relay?.url === url) return;
    relay?.close();
    relay = url ? new RelayConnection(url) : null;
    if (relay) relay.onFrame = (frame) => pc.nic.receive(frame);
  };
  const emulator = new Emulator(pc);
  if (import.meta.env.DEV) Object.assign(window, { pc, emulator });
  const screen = new Screen(canvas);
  screen.onAspect = (aspect) => document.documentElement.style.setProperty('--screen-aspect', String(aspect));
  const input = new BrowserInput(() => pc.kbc, canvas);
  input.attach(window);
  input.onMouseCapture = (captured) => (mouseLabel.hidden = captured);
  const focusScreen = () => canvas.focus();

  let running = false;
  let failed = false;
  /** The running machine's hard disk (null for none). */
  let disk: HardDiskImage | null = null;
  let diskName = '';
  /** Machines whose stored disk machine setup changed, so the PC must restart to see it. */
  const changedDisks = new Set<MachineId>();

  let saving: Promise<void> | null = null;
  const persistDisk = async (): Promise<void> => {
    while (saving) await saving;
    if (!disk || disk.dirty.size === 0) return;
    saving = hardDisks.persist(choices.machine, disk).finally(() => (saving = null));
    await saving;
  };

  const showDisk = () => drives.show('hd', disk ? diskName : null, disk ? sizeLabel(disk.bytes.length) : '');

  const startMachine = async (next: MachineChoices) => {
    running = false;
    await persistDisk();
    choices = next;
    machineRecord.write(choices);
    changedDisks.clear();
    const info = await hardDisks.info(choices.machine);
    disk = await hardDisks.load(choices.machine, (share) => (statusLine.textContent = `Loading the hard disk: ${Math.round(share * 100)}%`));
    diskName = info?.name ?? '';
    pc.setConfig(machineConfig(choices));
    connectRelay(choices.relayUrl);
    pc.attachHardDisk(disk);
    pc.powerOn();
    showDisk();
    failed = false;
    running = true;
    trackMachineStarted(choices.machine);
    focusScreen();
  };

  const replaceDisk = async (machine: MachineId, image: HardDiskImage, name: string, onProgress?: (share: number) => void) => {
    if (machine === choices.machine) disk = null;
    await hardDisks.replace(machine, image, name, onProgress);
    changedDisks.add(machine);
  };

  const openSetup = async (options: { firstVisit: boolean }) => {
    const wasRunning = running;
    running = false;
    await persistDisk();
    const result = await askForMachine(
      setupPanel,
      choices,
      {
        diskInfo: (machine) => hardDisks.info(machine),
        newDisk: (machine, megabytes) => replaceDisk(machine, HardDiskImage.blank(megabytes), 'New disk'),
        importDisk: async (machine, file, onProgress) => replaceDisk(machine, openDiskImage(new Uint8Array(await file.arrayBuffer())), file.name, onProgress),
        exportDisk: async (machine) => {
          const image = machine === choices.machine && disk ? disk : await hardDisks.load(machine);
          if (image) downloadFile(image.bytes, `${machine}-hard-disk.img`);
        },
        deleteDisk: async (machine) => {
          if (machine === choices.machine) disk = null;
          await hardDisks.delete(machine);
          changedDisks.add(machine);
        },
      },
      options,
    );
    if (result) await startMachine(result);
    else if (changedDisks.has(choices.machine) || !wasRunning) await startMachine(choices);
    else {
      running = true;
      focusScreen();
    }
  };

  const toolbar = attachToolbar(requireElement('#toolbar'), {
    onPause: (paused) => screenFrame.classList.toggle('paused', paused),
    onCtrlAltDel: () => input.pressCombination(['ControlLeft', 'AltLeft', 'Delete']),
    onReset: () => {
      pc.reset();
      failed = false;
    },
    onPowerCycle: () => {
      pc.powerOn();
      failed = false;
    },
    onFullscreen: () => void screenFrame.requestFullscreen?.(),
    onMachineSetup: () => void openSetup({ firstVisit: false }).catch(showError),
    focusScreen,
  });

  const insertFile = async (file: File) => {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.zip')) {
      const [best] = await usableFilesInZip(new Uint8Array(await file.arrayBuffer()));
      if (!best) throw new Error(`${file.name} has no CD, floppy or disk images in it.`);
      return insertFile(best);
    }
    if (lower.endsWith('.iso') || lower.endsWith('.cdr')) {
      pc.insertCd(new CdImage(new Uint8Array(await file.arrayBuffer()), file.name));
      drives.show('cdrom', file.name, sizeLabel(file.size));
      return;
    }
    const hardDiskType = HARD_DISK_EXTENSIONS.some((extension) => lower.endsWith(extension));
    if (!hardDiskType && file.size <= MAX_FLOPPY_BYTES) {
      pc.insertFloppy(0, new FloppyImage(new Uint8Array(await file.arrayBuffer()), file.name));
      drives.show('floppy', file.name, sizeLabel(file.size));
      return;
    }
    if (hardDiskType || /\.(img|ima)$/.test(lower)) {
      const preset = MACHINES[choices.machine];
      if (!confirm(`Make ${file.name} the hard disk of the ${preset.name} machine? It replaces the hard disk there now, and the PC restarts.`)) return;
      const image = openDiskImage(new Uint8Array(await file.arrayBuffer()));
      running = false;
      await persistDisk();
      await replaceDisk(choices.machine, image, file.name, (share) => (statusLine.textContent = `Storing ${file.name}: ${Math.round(share * 100)}%`));
      await startMachine(choices);
      return;
    }
    if (file.size % CD_SECTOR_BYTES === 0) {
      pc.insertCd(new CdImage(new Uint8Array(await file.arrayBuffer()), file.name));
      drives.show('cdrom', file.name, sizeLabel(file.size));
      return;
    }
    throw new Error(`${file.name} isn't a CD (.iso), floppy or hard disk image.`);
  };

  const drives = attachDrives(requireElement('#drives'), {
    onFiles: async (files) => {
      for (const file of files) await insertFile(file);
    },
    onEject: (drive) => {
      if (drive === 'cdrom') pc.insertCd(null);
      else pc.insertFloppy(0, null);
      drives.show(drive, null);
    },
    onDownloadFloppy: () => {
      const floppy = pc.fdc.drives[0].disk;
      if (floppy) downloadFile(floppy.bytes, floppy.name.replace(/\.[^.]*$/, '') + '.img');
    },
    focusScreen,
  });

  function showError(error: unknown): void {
    toolbar.showMessage(error instanceof Error ? error.message : String(error), true);
  }

  // Changes to the hard disk are saved every few seconds while the disk is quiet, and when the page is left.
  setInterval(() => {
    if (disk?.dirty.size && !pc.ide[0].drives[0]?.active) persistDisk().catch(showError);
  }, PERSIST_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) persistDisk().catch(showError);
  });
  window.addEventListener('pagehide', () => void persistDisk());
  window.addEventListener('beforeunload', (event) => {
    if (disk?.dirty.size) {
      void persistDisk();
      event.preventDefault();
    }
  });

  let last = performance.now();
  let lastStatus = 0;
  const frame = (now: number) => {
    const elapsed = now - last;
    last = now;
    if (running && !toolbar.paused && !failed) {
      try {
        emulator.run(elapsed);
      } catch (error) {
        failed = true;
        console.error(error);
        showError(new Error(`The emulator stopped: ${error instanceof Error ? error.message : String(error)}. Power cycle to restart.`));
      }
    }
    if (running) {
      screen.draw(pc.vga);
      drives.setLed('floppy', pc.fdc.drives[0].activeUntil > pc.now());
      drives.setLed('cdrom', pc.cdrom.active);
      drives.setLed('hd', pc.ide[0].drives[0]?.active ?? false);
    }
    if (now - lastStatus > 500) {
      lastStatus = now;
      if (running) {
        const preset = MACHINES[choices.machine];
        const speed = toolbar.paused ? 'paused' : `${Math.round(emulator.speed * 100)}% speed`;
        const network = relay ? `, ${NETWORK_STATES[relay.state]}` : '';
        statusLine.textContent = `${preset.name} machine, ${choices.memoryMb} MB, ${pc.vga.width}×${pc.vga.height}, ${speed}${network}`;
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  if (firstVisit) await openSetup({ firstVisit: true });
  else await startMachine(choices);
}

start().catch((error: unknown) => {
  console.error(error);
  statusLine.textContent = error instanceof Error ? error.message : String(error);
});
