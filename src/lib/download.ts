export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadText(text: string, filename: string, type = 'text/plain'): void {
  downloadBlob(new Blob([text], { type }), filename);
}

/** Timestamped graph filename, e.g. `node-graph-2026-07-04-03-45.json`. */
export function graphFileName(date: Date): string {
  const stamp = date.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `node-graph-${stamp}.json`;
}

/** Slugify a preview title into a download filename, e.g. `grey-depth.png`. */
export function previewFileName(title: string, ext: string): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'output';
  return `${base}.${ext}`;
}
