import type { Workspace } from '../../lib/services/workspace.svelte';
import type { Annotation, Asset, Entity, EvidenceData } from '../../lib/domain/types';
import { defaultData } from '../../lib/domain/defaults';
import { imageDimensions, MAX_IMAGE_PIXELS, MAX_IMAGE_EDGE } from './image-dimensions';
export { MAX_IMAGE_PIXELS } from './image-dimensions';
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
export function blobOf(bytes: Uint8Array, type: string) {
  return new Blob([new Uint8Array(bytes).buffer], { type });
}
export async function imageFrom(bytes: Uint8Array, mimeType: string): Promise<HTMLImageElement> {
  imageDimensions(bytes, mimeType);
  const url = URL.createObjectURL(blobOf(bytes, mimeType));
  const img = new Image();
  try {
    img.src = url;
    await img.decode();
    if (
      img.naturalWidth * img.naturalHeight > MAX_IMAGE_PIXELS ||
      Math.max(img.naturalWidth, img.naturalHeight) > MAX_IMAGE_EDGE
    )
      throw new Error('Image exceeds 16 megapixels or 8,192 pixels on one edge.');
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
export function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) =>
        b
          ? b.size > 32 * 1024 * 1024
            ? reject(
                new Error(
                  'The normalized image exceeds 32 MiB. Capture or import a smaller region.',
                ),
              )
            : void bytesOf(b).then(resolve, reject)
          : reject(new Error('Could not encode the image.')),
      'image/png',
    ),
  );
}
export function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation) {
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = a.stroke ?? 3;
  ctx.lineCap = 'round';
  const x = a.x,
    y = a.y,
    w = a.width,
    h = a.height;
  if (a.tool === 'redact') {
    ctx.fillStyle = '#000000';
    ctx.fillRect(
      Math.floor(Math.min(x, x + w)),
      Math.floor(Math.min(y, y + h)),
      Math.ceil(Math.abs(w)) + 1,
      Math.ceil(Math.abs(h)) + 1,
    );
  } else if (a.tool === 'rectangle') {
    ctx.strokeRect(x, y, w, h);
  } else if (a.tool === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, 2 * Math.PI);
    ctx.stroke();
  } else if (a.tool === 'highlight') {
    ctx.globalAlpha = 0.3;
    ctx.fillRect(x, y, w, h);
  } else if (a.tool === 'arrow') {
    const angle = Math.atan2(h, w),
      head = Math.max(12, ctx.lineWidth * 4);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y + h);
    ctx.moveTo(x + w - head * Math.cos(angle - 0.45), y + h - head * Math.sin(angle - 0.45));
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w - head * Math.cos(angle + 0.45), y + h - head * Math.sin(angle + 0.45));
    ctx.stroke();
  } else if (a.tool === 'text') {
    ctx.font = `600 ${Math.max(16, a.stroke ?? 20)}px Lexend`;
    ctx.textBaseline = 'top';
    ctx.fillText(a.text ?? '', x, y);
  } else if (a.tool === 'number') {
    const radius = Math.max(15, (a.stroke ?? 3) * 5);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${radius}px Lexend`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(a.text ?? '1', x, y);
  }
  ctx.restore();
}
export async function flattenImage(
  bytes: Uint8Array,
  mime: string,
  annotations: Annotation[] = [],
  crop?: EvidenceData['crop'],
) {
  const img = await imageFrom(bytes, mime);
  const full = document.createElement('canvas');
  full.width = img.naturalWidth;
  full.height = img.naturalHeight;
  const ctx = full.getContext('2d');
  if (!ctx) throw new Error('Image processing is unavailable.');
  ctx.drawImage(img, 0, 0);
  // Redactions are painted last so every covered source pixel is replaced opaquely.
  for (const a of annotations.filter((a) => a.tool !== 'redact')) drawAnnotation(ctx, a);
  for (const a of annotations.filter((a) => a.tool === 'redact')) drawAnnotation(ctx, a);
  if (!crop) return { bytes: await canvasPng(full), width: full.width, height: full.height };
  const x = Math.max(0, Math.floor(crop.x)),
    y = Math.max(0, Math.floor(crop.y));
  const width = Math.min(full.width - x, Math.floor(crop.width)),
    height = Math.min(full.height - y, Math.floor(crop.height));
  if (width < 1 || height < 1) throw new Error('Crop must intersect the image.');
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const out = output.getContext('2d')!;
  out.drawImage(full, x, y, width, height, 0, 0, width, height);
  return { bytes: await canvasPng(output), width, height };
}
function inferMime(file: File) {
  if (file.type) return file.type.split(';')[0];
  const ext = file.name.split('.').at(-1)?.toLowerCase();
  return (
    (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
        txt: 'text/plain',
        log: 'text/plain',
        json: 'application/json',
        csv: 'text/csv',
        xml: 'application/xml',
      } as Record<string, string>
    )[ext ?? ''] ?? 'application/octet-stream'
  );
}
export async function importEvidence(
  workspace: Workspace,
  files: File[],
  source: EvidenceData['source'] = 'import',
): Promise<Entity<'evidence'>[]> {
  const finishOperation = workspace.beginOperation();
  try {
    const projectId = workspace.projectId;
    const result: Entity<'evidence'>[] = [];
    for (const file of files) {
      if (!file.size || file.size > MAX_FILE_BYTES)
        throw new Error(`${file.name}: choose a nonempty file up to 64 MiB.`);
      const mime = inferMime(file);
      let bytes: Uint8Array = await bytesOf(file);
      let original: Asset | undefined, width: number | undefined, height: number | undefined;
      let filename = file.name,
        outputMime = mime;
      if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) {
        const clean = await flattenImage(bytes, mime);
        original = await workspace.repo.importAsset(projectId, file.name, mime, bytes);
        bytes = clean.bytes;
        width = clean.width;
        height = clean.height;
        filename = file.name.replace(/\.[^.]+$/, '') + '.png';
        outputMime = 'image/png';
      } else if (mime.startsWith('image/'))
        throw new Error(
          'Import PNG, JPEG, WebP or GIF images. Vector and active image formats are not accepted.',
        );
      const asset = await workspace.repo.importAsset(projectId, filename, outputMime, bytes);
      if (workspace.projectId !== projectId)
        throw new Error(
          'The project changed during import. Please import into the selected project again.',
        );
      result.push(
        await workspace.create('evidence', file.name, {
          ...defaultData('evidence'),
          ...asset,
          assetId: asset.id,
          filename,
          mimeType: outputMime,
          source,
          width,
          height,
          originalAssetId: original?.id,
        }),
      );
    }
    return result;
  } finally {
    finishOperation();
  }
}
export async function captureEvidence(workspace: Workspace) {
  const finishOperation = workspace.beginOperation();
  try {
    const projectId = workspace.projectId,
      original = await workspace.repo.captureScreen(projectId);
    if (!original) return null;
    const clean = await flattenImage(
      await workspace.repo.readAsset(projectId, original.id),
      'image/png',
    );
    const asset = await workspace.repo.importAsset(
      projectId,
      'Screenshot.png',
      'image/png',
      clean.bytes,
    );
    if (workspace.projectId !== projectId)
      throw new Error('The project changed during capture. Capture again in the selected project.');
    return await workspace.create('evidence', `Screenshot · ${new Date().toLocaleTimeString()}`, {
      ...defaultData('evidence'),
      assetId: asset.id,
      filename: asset.filename,
      mimeType: asset.mimeType,
      hash: asset.hash,
      size: asset.size,
      width: clean.width,
      height: clean.height,
      originalAssetId: original.id,
      source: 'capture',
    });
  } finally {
    finishOperation();
  }
}
