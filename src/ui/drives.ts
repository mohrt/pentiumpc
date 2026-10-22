export type DriveKind = 'floppy' | 'cdrom';

export interface DrivesCallbacks {
  /** Files chosen or dropped (each goes in the drive it suits). */
  onFiles(files: File[]): Promise<void>;
  onEject(drive: DriveKind): void;
  /** Saves the floppy as it is now (with what programs wrote to it). */
  onDownloadFloppy(): void;
  focusScreen(): void;
}

export interface DrivesPanel {
  show(drive: DriveKind | 'hd', name: string | null, detail?: string): void;
  setLed(drive: DriveKind | 'hd', on: boolean): void;
  showMessage(text: string, isError?: boolean): void;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Drives panel is missing ${selector}`);
  return element;
}

/** The floppy drive, the CD-ROM drive and the hard disk, with their lights, and dropping files onto the page. */
export function attachDrives(root: HTMLElement, callbacks: DrivesCallbacks): DrivesPanel {
  const fileInput = requireChild<HTMLInputElement>(root, 'input[name="media-file"]');
  const message = requireChild<HTMLElement>(root, '.drives-message');
  const drive = (kind: string) => requireChild<HTMLElement>(root, `.drive[data-drive="${kind}"]`);
  let messageTimer: ReturnType<typeof setTimeout> | undefined;

  const showMessage = (text: string, isError = false) => {
    clearTimeout(messageTimer);
    message.textContent = text;
    message.classList.toggle('error', isError);
    if (!isError) messageTimer = setTimeout(() => (message.textContent = ''), 6000);
  };

  const open = (files: File[]) => {
    if (!files.length) return;
    callbacks
      .onFiles(files)
      .catch((error: unknown) => showMessage(error instanceof Error ? error.message : String(error), true))
      .finally(() => callbacks.focusScreen());
  };

  root.querySelectorAll<HTMLButtonElement>('[data-action="choose"]').forEach((button) => button.addEventListener('click', () => fileInput.click()));
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    open(files);
  });
  for (const kind of ['floppy', 'cdrom'] as const) {
    requireChild<HTMLButtonElement>(drive(kind), '[data-action="eject"]').addEventListener('click', () => {
      callbacks.onEject(kind);
      callbacks.focusScreen();
    });
  }
  requireChild<HTMLButtonElement>(drive('floppy'), '[data-action="download"]').addEventListener('click', () => callbacks.onDownloadFloppy());

  // Dropping files anywhere on the page.
  let dragDepth = 0;
  document.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    dragDepth++;
    document.body.classList.add('dropping');
  });
  document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dropping');
    }
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dropping');
    open([...(event.dataTransfer?.files ?? [])]);
  });

  return {
    show(kind, name, detail = '') {
      const element = drive(kind);
      element.dataset.state = name ? 'loaded' : 'empty';
      requireChild<HTMLElement>(element, '.media-name').textContent = name ?? (kind === 'hd' ? 'No hard disk' : 'Empty');
      requireChild<HTMLElement>(element, '.media-detail').textContent = detail;
    },
    setLed(kind, on) {
      drive(kind).classList.toggle('active', on);
    },
    showMessage,
  };
}
