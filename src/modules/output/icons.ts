// Zusätzliche Symbole des Moduls „output“ (24×24, Linien in currentColor).
import { registerIcon } from '../../ui/icons';

const B = '#2a6fd6';
registerIcon('titleblock', `<rect x="2" y="4" width="20" height="16" fill="#fff" stroke="currentColor"/><path d="M12 14 H22 M12 14 V20 M12 17 H22" stroke="${B}"/>`);
registerIcon('placeview', `<rect x="2" y="3" width="20" height="18" fill="#fff" stroke="currentColor"/><rect x="5" y="6" width="9" height="7" fill="#dbe8f8" stroke="${B}"/><path d="M5 16 H11" stroke="currentColor" stroke-width="1.6"/>`);
registerIcon('callout', `<rect x="3" y="5" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M15 9 L18 7" stroke="currentColor"/><circle cx="19.5" cy="5.5" r="3" fill="#fff" stroke="${B}"/>`);
registerIcon('csv', `<path d="M5 2 H14 L19 7 V22 H5 Z" fill="#fff" stroke="currentColor"/><text x="12" y="17" font-size="6" font-weight="bold" text-anchor="middle" fill="#2f8f2f">CSV</text>`);
registerIcon('svg', `<path d="M5 2 H14 L19 7 V22 H5 Z" fill="#fff" stroke="currentColor"/><text x="12" y="17" font-size="6" font-weight="bold" text-anchor="middle" fill="${B}">SVG</text>`);
registerIcon('png', `<path d="M5 2 H14 L19 7 V22 H5 Z" fill="#fff" stroke="currentColor"/><text x="12" y="17" font-size="6" font-weight="bold" text-anchor="middle" fill="#a050c0">PNG</text>`);
registerIcon('explode', `<rect x="8" y="8" width="8" height="8" fill="#dbe8f8" stroke="currentColor"/><path d="M3 3 L7 7 M21 3 L17 7 M3 21 L7 17 M21 21 L17 17" stroke="${B}" stroke-width="1.5"/>`);
registerIcon('layers', `<path d="M12 3 L22 8 L12 13 L2 8 Z" fill="#dbe8f8" stroke="currentColor"/><path d="M2 12 L12 17 L22 12 M2 16 L12 21 L22 16" fill="none" stroke="currentColor"/>`);
registerIcon('imgscale', `<rect x="3" y="5" width="18" height="14" fill="#fff" stroke="currentColor"/><path d="M6 15 L18 9" stroke="${B}" stroke-width="1.5"/><circle cx="6" cy="15" r="1.6" fill="${B}"/><circle cx="18" cy="9" r="1.6" fill="${B}"/>`);
registerIcon('planview', `<rect x="3" y="3" width="18" height="18" fill="#fff" stroke="currentColor"/><path d="M3 10 H12 V21 M12 14 H21" stroke="currentColor"/><path d="M16 3 V8" stroke="${B}" stroke-width="2"/>`);
