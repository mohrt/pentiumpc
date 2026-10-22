import type { Vga } from '../video/vga';

/** The picture's shape on a monitor: the classic modes fill a 4:3 screen; larger ones keep square pixels. */
function displayAspect(width: number, height: number): number {
  if (height <= 480) return 4 / 3;
  return width / height;
}

/** Draws the VGA's picture on a canvas each animation frame. */
export class Screen {
  private readonly context: CanvasRenderingContext2D;
  private image: ImageData | null = null;
  private pixels = new Uint32Array(0);
  private aspect = 4 / 3;
  /** Called with the width / height ratio the canvas should be shown at, whenever it changes. */
  onAspect: (aspect: number) => void = () => {};

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is not available');
    this.context = context;
  }

  draw(vga: Vga): void {
    vga.render();
    const { width, height } = vga;
    if (!this.image || this.image.width !== width || this.image.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.image = this.context.createImageData(width, height);
      this.pixels = new Uint32Array(this.image.data.buffer);
      const aspect = displayAspect(width, height);
      if (aspect !== this.aspect) {
        this.aspect = aspect;
        this.onAspect(aspect);
      }
    }
    this.pixels.set(vga.framebuffer.subarray(0, width * height));
    this.context.putImageData(this.image, 0, 0);
  }

  /** A dark screen, shown while the PC is off. */
  showOff(): void {
    this.context.fillStyle = '#000';
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
