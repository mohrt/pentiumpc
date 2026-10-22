import { MACHINES, type MachineId } from '../machines';
import { HARD_DISK_SIZES, type HardDiskInfo } from '../storage/hard-disks';

export interface MachineChoices {
  machine: MachineId;
  memoryMb: number;
  /** The WebSocket address of the network relay ('' for no network). */
  relayUrl: string;
}

export const MEMORY_SIZES = [8, 16, 32, 64, 128, 256];

/** Why a relay address can't be used, or null if it can ('' is no relay). */
export function relayProblem(address: string): string | null {
  if (!address) return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return 'That relay address is not a web address (it starts wss:// or ws://).';
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return 'A relay address starts wss:// (or ws:// for one on this computer).';
  if (url.protocol === 'ws:' && location.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return 'This page is served over https, so the browser only allows a wss:// relay, or ws:// on this computer (localhost).';
  }
  return null;
}

/** What the panel does with the chosen machine's hard disk (each machine keeps its own). */
export interface MachineSetupHooks {
  diskInfo(machine: MachineId): Promise<HardDiskInfo | null>;
  newDisk(machine: MachineId, megabytes: number): Promise<void>;
  importDisk(machine: MachineId, file: File, onProgress: (done: number) => void): Promise<void>;
  exportDisk(machine: MachineId): Promise<void>;
  deleteDisk(machine: MachineId): Promise<void>;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Machine setup is missing ${selector}`);
  return element;
}

const sizeLabel = (bytes: number) => (bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${Math.round(bytes / (1 << 20))} MB`);

/**
 * Shows the machine setup panel over the screen: the machine (DOS and Windows 3.1,
 * Windows 95, Windows 98), its memory, its hard disk and the network relay. Resolves with the
 * choices when the user starts the PC, or null if they close the panel.
 */
export function askForMachine(panel: HTMLElement, current: MachineChoices, hooks: MachineSetupHooks, options: { firstVisit: boolean }): Promise<MachineChoices | null> {
  const machineSelect = requireChild<HTMLSelectElement>(panel, 'select[name="machine"]');
  const description = requireChild<HTMLElement>(panel, '.machine-description');
  const memorySelect = requireChild<HTMLSelectElement>(panel, 'select[name="memory"]');
  const diskInfo = requireChild<HTMLElement>(panel, '.disk-info');
  const diskSize = requireChild<HTMLSelectElement>(panel, 'select[name="disk-size"]');
  const diskFile = requireChild<HTMLInputElement>(panel, 'input[name="disk-file"]');
  const diskStatus = requireChild<HTMLElement>(panel, '.disk-status');
  const buttons = (action: string) => requireChild<HTMLButtonElement>(panel, `[data-action="${action}"]`);
  const firstVisitText = requireChild<HTMLElement>(panel, '.first-visit');
  const relayInput = requireChild<HTMLInputElement>(panel, 'input[name="relay-url"]');
  const relayStatus = requireChild<HTMLElement>(panel, '.relay-status');
  const cancel = buttons('cancel-setup');

  machineSelect.replaceChildren(
    ...Object.values(MACHINES).map((preset) => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      return option;
    }),
  );
  memorySelect.replaceChildren(
    ...MEMORY_SIZES.map((size) => {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = `${size} MB`;
      return option;
    }),
  );
  diskSize.replaceChildren(
    ...HARD_DISK_SIZES.map((size) => {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = size >= 1000 ? `${size / 1000} GB` : `${size} MB`;
      return option;
    }),
  );

  const machine = () => machineSelect.value as MachineId;
  let busy = false;
  const setBusy = (value: boolean) => {
    busy = value;
    panel.querySelectorAll<HTMLButtonElement>('button').forEach((button) => (button.disabled = value));
  };
  const refreshDisk = async () => {
    const info = await hooks.diskInfo(machine());
    diskInfo.textContent = info ? `${info.name}, ${sizeLabel(info.bytes)}` : 'No hard disk yet';
    buttons('export-disk').hidden = buttons('delete-disk').hidden = !info;
  };
  const showMachine = () => {
    const preset = MACHINES[machine()];
    description.textContent = preset.description;
    diskSize.value = String(preset.newDiskMb);
    void refreshDisk();
  };

  machineSelect.value = current.machine;
  memorySelect.value = String(current.memoryMb);
  firstVisitText.hidden = !options.firstVisit;
  cancel.hidden = options.firstVisit;
  relayInput.value = current.relayUrl;
  relayStatus.textContent = '';
  showMachine();
  diskStatus.textContent = '';
  panel.hidden = false;
  document.body.classList.add('in-setup');

  const run = async (action: () => Promise<void>, done: string) => {
    if (busy) return;
    setBusy(true);
    diskStatus.classList.remove('error');
    try {
      await action();
      diskStatus.textContent = done;
    } catch (error) {
      diskStatus.textContent = error instanceof Error ? error.message : String(error);
      diskStatus.classList.add('error');
    } finally {
      setBusy(false);
      await refreshDisk();
    }
  };

  return new Promise((resolve) => {
    const listeners: [HTMLElement, string, () => void][] = [];
    const listen = (element: HTMLElement, type: string, handler: () => void) => {
      element.addEventListener(type, handler);
      listeners.push([element, type, handler]);
    };
    const finish = (result: MachineChoices | null) => {
      for (const [element, type, handler] of listeners) element.removeEventListener(type, handler);
      panel.hidden = true;
      document.body.classList.remove('in-setup');
      resolve(result);
    };

    listen(machineSelect, 'change', () => {
      memorySelect.value = String(MACHINES[machine()].config.memoryMb);
      showMachine();
    });
    listen(buttons('new-disk'), 'click', () => {
      void (async () => {
        const megabytes = Number(diskSize.value);
        if ((await hooks.diskInfo(machine())) && !confirm(`Replace this machine's hard disk with a new, empty ${diskSize.selectedOptions[0].textContent} disk? Everything on the old one is lost.`)) return;
        await run(() => hooks.newDisk(machine(), megabytes), 'A new, empty hard disk is ready.');
      })();
    });
    listen(buttons('import-disk'), 'click', () => diskFile.click());
    listen(diskFile, 'change', () => {
      const file = diskFile.files?.[0];
      diskFile.value = '';
      if (!file) return;
      void run(
        () => hooks.importDisk(machine(), file, (share) => (diskStatus.textContent = `Storing ${file.name}: ${Math.round(share * 100)}%`)),
        `${file.name} is this machine's hard disk now.`,
      );
    });
    listen(buttons('export-disk'), 'click', () => void run(() => hooks.exportDisk(machine()), 'The hard disk image is downloading.'));
    listen(buttons('delete-disk'), 'click', () => {
      if (!confirm("Delete this machine's hard disk, and everything on it?")) return;
      void run(() => hooks.deleteDisk(machine()), 'The hard disk is deleted.');
    });
    listen(relayInput, 'input', () => (relayStatus.textContent = ''));
    listen(buttons('start-machine'), 'click', () => {
      if (busy) return;
      const relayUrl = relayInput.value.trim();
      const problem = relayProblem(relayUrl);
      relayStatus.textContent = problem ?? '';
      if (problem) {
        relayInput.focus();
        return;
      }
      finish({ machine: machine(), memoryMb: Number(memorySelect.value), relayUrl });
    });
    listen(cancel, 'click', () => {
      if (!busy) finish(null);
    });
  });
}
