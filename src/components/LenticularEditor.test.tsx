import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../nodes'; // register built-ins
import { LenticularEditor, LensGridEditor } from './LenticularEditor';
import { useStore } from '../store/store';
import { setPlatform } from '../lib/platform';

const s = () => useStore.getState();

/** jsdom's Blob has no arrayBuffer(), so go through FileReader. */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Two solid-colour sources wired into a Lenticular node, already computed. */
async function graphWithFrames() {
  const id = s().addNode('lenticular');
  // Small + coarse so the editor's download renders stay fast in a test.
  s().updateNodeConfig(id, { widthMm: 25.4, ppi: 100, lpi: 10, heightMm: 5 });
  for (const color of ['#ff0000', '#0000ff']) {
    const src = s().addNode('solidColor');
    s().updateNodeConfig(src, { width: 20, height: 20, color });
    s().addConnection({ source: src, sourceHandle: 'out', target: id, targetHandle: 'frames' });
  }
  await s().processAutoRun();
  return id;
}

beforeEach(() => {
  localStorage.clear();
  s().reset();
});

describe('LenticularEditor', () => {
  it('renders nothing for an unknown node id', () => {
    const { container } = render(<LenticularEditor nodeId="nope" />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the solved lens geometry for the current settings', () => {
    const id = s().addNode('lenticular'); // defaults: 45 LPI, 0.9 mm, RI 1.5
    render(<LenticularEditor nodeId={id} />);
    expect(screen.getByText('Pitch')).toBeInTheDocument();
    expect(screen.getByText(/0\.564 mm/)).toBeInTheDocument(); // 25.4 / 45
    expect(screen.getByText('Lens sag')).toBeInTheDocument();
    expect(screen.getByText('Flat base under lens')).toBeInTheDocument();
  });

  it('reports the two rasters separately once frames are connected', async () => {
    const id = await graphWithFrames(); // 25.4 mm, 100 PPI, 10 LPI, 2 frames
    render(<LenticularEditor nodeId={id} />);
    expect(screen.getByText('100 × 100 px @ 100 PPI')).toBeInTheDocument(); // the lens
    expect(screen.getByText('40 × 40 px')).toBeInTheDocument(); // the artwork
  });

  it('asks for frames and disables the downloads until two are connected', () => {
    const id = s().addNode('lenticular');
    render(<LenticularEditor nodeId={id} />);
    expect(screen.getByText(/Connect at least 2 images/)).toBeInTheDocument();
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });

  it('warns when no lens can focus within the configured height', () => {
    const id = s().addNode('lenticular');
    s().updateNodeConfig(id, { heightMm: 0.4 });
    render(<LenticularEditor nodeId={id} />);
    expect(screen.getByText(/no lens can focus/)).toBeInTheDocument();
  });

  it('labels each calibration button with its own min → max range', () => {
    const id = s().addNode('lenticular');
    s().updateNodeConfig(id, { lpiMin: 30, lpiMax: 70 });
    render(<LenticularEditor nodeId={id} />);
    expect(screen.getByRole('button', { name: 'Height: 0.6 → 1.4' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'RI: 1.4 → 1.6' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'LPI: 30 → 70' })).toBeInTheDocument();
  });

  it('downloads a real 16-bit PNG of the gloss depth map', async () => {
    const id = await graphWithFrames();
    const downloads: { name: string; blob: Blob }[] = [];
    let lastBlob: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      lastBlob = blob;
      return 'blob:test';
    });
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    // Capture the anchor click that downloadBlob triggers.
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push({ name: this.download, blob: lastBlob! });
    });

    render(<LenticularEditor nodeId={id} />);
    await userEvent.click(screen.getByRole('button', { name: /16-bit gloss depth map/ }));
    await waitFor(() => expect(downloads).toHaveLength(1));

    expect(downloads[0].name).toMatch(/^lenticular-depth16-10lpi-5mm\.png$/);
    const bytes = await blobBytes(downloads[0].blob);
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes[24]).toBe(16); // IHDR bit depth
    expect(bytes[25]).toBe(0); // greyscale
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it('downloads all three sheets of a calibration set', async () => {
    const id = await graphWithFrames();
    const names: string[] = [];
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    // The interlaced sheets go through the canvas PNG encoder; jsdom has none.
    setPlatform({ encodePngBlob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }) });

    render(<LenticularEditor nodeId={id} />);
    await userEvent.click(screen.getByRole('button', { name: /^LPI:/ }));
    await waitFor(() => expect(names).toHaveLength(3));

    const stem = 'lenticular-calib-lpi-40-to-50-9bands';
    expect(names[0]).toBe(`${stem}-interlaced.png`);
    expect(names[1]).toBe(`${stem}-switch.png`);
    // Auto height is on, so the 40 LPI band (a 4× coarser pitch than the node's
    // 10 LPI) sets the scale at 4× its 5 mm height ÷ 4 … i.e. 1.25 mm.
    expect(names[2]).toBe(`${stem}-depth16-max1-25mm.png`);
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it('holds the height across the LPI sweep when auto height is off', async () => {
    const id = await graphWithFrames();
    const names: string[] = [];
    s().updateNodeConfig(id, { lpiAutoHeight: false });
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    setPlatform({ encodePngBlob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }) });

    render(<LenticularEditor nodeId={id} />);
    expect(screen.getByText(/holds Height at 5\.000 mm for every band/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^LPI:/ }));
    await waitFor(() => expect(names).toHaveLength(3));

    // Every band keeps the node's own 5 mm stack.
    expect(names[2]).toBe('lenticular-calib-lpi-40-to-50-9bands-depth16-max5mm.png');
    click.mockRestore();
    vi.unstubAllGlobals();
  });
});

/** A 2×2 Lens Grid with all four views wired and computed. */
async function gridWithViews(connect = ['c0r0', 'c1r0', 'c0r1', 'c1r1']) {
  const id = s().addNode('lensGrid');
  s().updateNodeConfig(id, { grid: 2, widthMm: 25.4, ppi: 100, lpi: 10, heightMm: 5 });
  for (const handle of connect) {
    const src = s().addNode('solidColor');
    s().updateNodeConfig(src, { width: 20, height: 20, color: '#ff0000' });
    s().addConnection({ source: src, sourceHandle: 'out', target: id, targetHandle: handle });
  }
  await s().processAutoRun();
  return id;
}

describe('LensGridEditor', () => {
  it('renders nothing for an unknown node id', () => {
    const { container } = render(<LensGridEditor nodeId="nope" />);
    expect(container.firstChild).toBeNull();
  });

  it('reports the grid, its per-view resolution and both rasters', async () => {
    const id = await gridWithViews();
    render(<LensGridEditor nodeId={id} />);
    expect(screen.getByText('2 × 2 = 4 views')).toBeInTheDocument();
    // Hex by default: rows √3/2 apart, so 12 rows of lenslets fit where 10
    // columns do, and the artwork grows to keep 2 px per tile down as well.
    expect(screen.getByText(/Hexagonal \(offset rows\) — 90\.7% under a cap/)).toBeInTheDocument();
    expect(screen.getByText('10 × 12 px (one per lenslet)')).toBeInTheDocument();
    expect(screen.getByText('100 × 100 px @ 100 PPI')).toBeInTheDocument(); // the lens
    // The artwork sizes itself and stops there: 47 px of interlace, well under
    // the 100 px the press could print.
    expect(screen.getByText('47 × 47 px')).toBeInTheDocument();
    expect(screen.getByText(/edges between view tiles on diagonals/)).toBeInTheDocument();
    for (const button of screen.getAllByRole('button')) expect(button).toBeEnabled();
  });

  it('reports a square array when the packing is switched back', async () => {
    const id = await gridWithViews();
    s().updateNodeConfig(id, { packing: 'square' });
    render(<LensGridEditor nodeId={id} />);
    expect(screen.getByText(/Square \(rows and columns\) — 78\.5% under a cap/)).toBeInTheDocument();
    expect(screen.getByText('10 × 10 px (one per lenslet)')).toBeInTheDocument();
    expect(screen.getByText('40 × 40 px')).toBeInTheDocument(); // 10 cells × 2 × 2
    expect(screen.getByText(/tiles the artwork in whole pixels/)).toBeInTheDocument();
  });

  it('names the unconnected cells and blocks the downloads', async () => {
    const id = await gridWithViews(['c0r0', 'c1r1']);
    render(<LensGridEditor nodeId={id} />);
    expect(screen.getByText(/Missing: Right · Up, Left · Down/)).toBeInTheDocument();
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });

  it('downloads calibration sheets under its own filename stem', async () => {
    const id = await gridWithViews();
    const names: string[] = [];
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    setPlatform({ encodePngBlob: async () => new Blob([new Uint8Array([1])], { type: 'image/png' }) });

    render(<LensGridEditor nodeId={id} />);
    await userEvent.click(screen.getByRole('button', { name: /^Height:/ }));
    await waitFor(() => expect(names).toHaveLength(3));

    expect(names[0]).toBe('lensgrid-calib-height-0-6-to-1-4-9bands-interlaced.png');
    expect(names[1]).toBe('lensgrid-calib-height-0-6-to-1-4-9bands-switch.png');
    expect(names[2]).toMatch(/^lensgrid-calib-height-0-6-to-1-4-9bands-depth16-max/);
    click.mockRestore();
    vi.unstubAllGlobals();
  });
});
