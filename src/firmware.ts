/** SeaBIOS and its VGA BIOS, from the site's bios/ folder. */
export async function loadFirmware(baseUrl: string): Promise<{ bios: Uint8Array; vgaBios: Uint8Array }> {
  const fetchBytes = async (name: string) => {
    const response = await fetch(`${baseUrl}bios/${name}`);
    if (!response.ok) throw new Error(`Could not load the PC's BIOS (${name}: HTTP ${response.status}).`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const [bios, vgaBios] = await Promise.all([fetchBytes('seabios.bin'), fetchBytes('vgabios.bin')]);
  return { bios, vgaBios };
}
