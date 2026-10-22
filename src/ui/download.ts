/** Saves bytes to the user's downloads folder under `filename`. */
export function downloadFile(bytes: Uint8Array, filename: string): void {
  // Hard disk images run to gigabytes, so the bytes go to the Blob without a copy.
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
