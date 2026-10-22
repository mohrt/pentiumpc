export interface ToolbarCallbacks {
  onPause(paused: boolean): void;
  /** Ctrl+Alt+Del, which the host keeps for itself. */
  onCtrlAltDel(): void;
  /** The reset button. */
  onReset(): void;
  /** Switches the PC off and on, keeping the disks in. */
  onPowerCycle(): void;
  onFullscreen(): void;
  onMachineSetup(): void;
  /** Gives keyboard focus back to the screen. */
  focusScreen(): void;
}

export interface Toolbar {
  readonly paused: boolean;
  setPaused(paused: boolean): void;
  showMessage(text: string, isError?: boolean): void;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Toolbar is missing ${selector}`);
  return element;
}

/** The row of machine controls under the screen. */
export function attachToolbar(root: HTMLElement, callbacks: ToolbarCallbacks): Toolbar {
  const message = requireChild<HTMLElement>(root, '.toolbar-message');
  const pauseButton = requireChild<HTMLButtonElement>(root, '[data-action="pause"]');
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;

  const showMessage = (text: string, isError = false) => {
    clearTimeout(messageTimer);
    message.textContent = text;
    message.classList.toggle('error', isError);
    if (!isError) messageTimer = setTimeout(() => (message.textContent = ''), 4000);
  };

  const onClick = (action: string, handler: () => void) =>
    requireChild<HTMLButtonElement>(root, `[data-action="${action}"]`).addEventListener('click', () => {
      try {
        handler();
      } catch (error) {
        showMessage(error instanceof Error ? error.message : String(error), true);
      }
      if (action !== 'machine-setup') callbacks.focusScreen();
    });

  const setPaused = (value: boolean) => {
    paused = value;
    pauseButton.textContent = paused ? 'Resume' : 'Pause';
    callbacks.onPause(paused);
  };
  onClick('pause', () => setPaused(!paused));
  onClick('ctrl-alt-del', () => callbacks.onCtrlAltDel());
  onClick('reset', () => callbacks.onReset());
  onClick('power', () => callbacks.onPowerCycle());
  onClick('fullscreen', () => callbacks.onFullscreen());
  onClick('machine-setup', () => callbacks.onMachineSetup());

  return {
    get paused() {
      return paused;
    },
    setPaused,
    showMessage,
  };
}
