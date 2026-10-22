type Gtag = (command: 'event', name: string, params: Record<string, string>) => void;

/**
 * Reports the PC starting to Google Analytics, with the machine chosen (never
 * the names of the user's files). Does nothing when the tag is blocked.
 */
export function trackMachineStarted(machine: string): void {
  const gtag = (globalThis as { gtag?: Gtag }).gtag;
  gtag?.('event', 'machine_started', { system: 'pentiumpc', machine });
}
