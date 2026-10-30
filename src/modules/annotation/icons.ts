// Zusätzliche Symbole der Beschriftungsbefehle (24×24, currentColor).
import { registerIcon } from '../../ui/icons';

const B = '#2a6fd6';
registerIcon('dimlinear', `<path d="M5 6 V18 M19 6 V18 M5 15 H19" stroke="currentColor"/><path d="M4 17 L6 13 M18 17 L20 13" stroke="currentColor"/><path d="M3 21 H21" stroke="${B}" stroke-dasharray="2 2"/><text x="12" y="12" font-size="6" text-anchor="middle" fill="${B}">2,5</text>`);
registerIcon('dimangular', `<path d="M4 20 L20 20 M4 20 L16 6" stroke="currentColor"/><path d="M13 20 A9 9 0 0 0 10.5 13" fill="none" stroke="${B}" stroke-width="1.4"/>`);
registerIcon('dimradial', `<circle cx="10" cy="14" r="7" fill="none" stroke="currentColor"/><path d="M10 14 L15 9" stroke="${B}" stroke-width="1.4"/><path d="M15 9 L12.5 9.6 L14.4 11.5 Z" fill="${B}"/><text x="19" y="7" font-size="6" text-anchor="middle" fill="${B}">R</text>`);
registerIcon('dimarc', `<path d="M4 18 A9 9 0 0 1 20 18" fill="none" stroke="currentColor"/><path d="M2 14 A11 11 0 0 1 22 14" fill="none" stroke="${B}" stroke-width="1.2"/><path d="M2.5 11 L4.5 15 M19.5 15 L21.5 11" stroke="${B}"/>`);
registerIcon('spotcoord', `<circle cx="7" cy="17" r="2" fill="none" stroke="currentColor"/><path d="M7 13 V21 M3 17 H11 M7 17 L13 9 H22" stroke="currentColor"/><text x="17" y="7.5" font-size="5.5" text-anchor="middle" fill="${B}">N/O</text>`);
registerIcon('tagall', `<path d="M2 9 L6 5 H14 V13 H6 Z" fill="#fff" stroke="currentColor"/><path d="M8 15 L12 11 H21 V19 H12 Z" fill="#fff" stroke="${B}"/><circle cx="12" cy="15" r="1" fill="${B}"/>`);
registerIcon('symbol', `<circle cx="12" cy="13" r="8" fill="#fff" stroke="currentColor"/><path d="M12 3 L8 17 L12 14 Z" fill="currentColor"/><path d="M12 3 L16 17 L12 14 Z" fill="#fff" stroke="currentColor"/>`);
registerIcon('editsketch', `<path d="M4 18 L4 6 L16 6 L16 18 Z" fill="none" stroke="#d0208c" stroke-width="1.6"/><path d="M13 21 L21 13 L23 15 L15 23 Z" fill="#f5d27a" stroke="currentColor"/>`);
registerIcon('leaderadd', `<path d="M3 21 L10 12 H14" stroke="currentColor" stroke-width="1.4"/><path d="M3 21 L4 17 L6.5 19 Z" fill="currentColor"/><text x="18" y="13" font-size="8" text-anchor="middle" fill="currentColor" font-weight="bold">A</text><path d="M17 3 V9 M14 6 H20" stroke="${B}" stroke-width="1.6"/>`);
registerIcon('dimtext', `<path d="M3 16 H21 M5 12 V20 M19 12 V20" stroke="currentColor"/><text x="12" y="10" font-size="8" text-anchor="middle" fill="${B}" font-weight="bold">ab</text>`);
registerIcon('spotbox', `<rect x="3" y="5" width="18" height="14" fill="#fff" stroke="currentColor"/><text x="12" y="10" font-size="4.6" text-anchor="middle" fill="${B}">OK -0.10</text><text x="12" y="14.5" font-size="4.6" text-anchor="middle" fill="${B}">UK -0.34</text><text x="12" y="18.5" font-size="3.6" text-anchor="middle" fill="currentColor">d=24</text>`);
