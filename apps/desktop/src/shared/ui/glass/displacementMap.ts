/** Edge refraction based on Shu Ding's liquid-glass distance-field approach. */
export function createDisplacementMap(width: number, height: number, radius: number) {
  const canvas = document.createElement("canvas");
  const resolution = Math.min(1, 640 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * resolution));
  canvas.height = Math.max(1, Math.round(height * resolution));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Glass refraction requires a 2D canvas");

  const image = context.createImageData(canvas.width, canvas.height);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const corner = Math.min(radius, halfWidth, halfHeight);
  const band = Math.min(24, Math.min(width, height) * 0.25);
  const strength = Math.min(12, Math.min(width, height) * 0.15);
  const scale = strength * 2;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const px = ((x + 0.5) / canvas.width - 0.5) * width;
      const py = ((y + 0.5) / canvas.height - 0.5) * height;
      const qx = Math.abs(px) - halfWidth + corner;
      const qy = Math.abs(py) - halfHeight + corner;
      const distance = Math.min(Math.max(qx, qy), 0)
        + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - corner;
      const edge = Math.max(0, Math.min(1, 1 + distance / band));
      const pull = edge * edge * (3 - 2 * edge) * strength;
      const index = (y * canvas.width + x) * 4;
      // SVG offset = scale * (channel - 0.5). The centre stays neutral.
      image.data[index] = (0.5 - px / halfWidth * pull / scale) * 255;
      image.data[index + 1] = (0.5 - py / halfHeight * pull / scale) * 255;
      image.data[index + 2] = 0;
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return { href: canvas.toDataURL(), scale };
}
