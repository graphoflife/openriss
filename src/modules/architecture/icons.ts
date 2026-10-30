// Zusätzliche Symbole (24×24) für Architektur-Befehle.
import { registerIcon, ICONS } from '../../ui/icons';

const B = '#2a6fd6', G = '#9aa4ae', M = '#d0208c';
const add = (name: string, body: string) => { if (!ICONS[name]) registerIcon(name, body); };

add('shaft', `<rect x="5" y="3" width="14" height="18" fill="#fff" stroke="currentColor"/><path d="M5 3 L19 21 M19 3 L5 21" stroke="${B}"/>`);
add('roomsep', `<rect x="3" y="3" width="18" height="18" fill="#e8f0fa" stroke="currentColor"/><path d="M12 3 V21" stroke="${B}" stroke-width="1.6"/>`);
add('editsketch', `<path d="M3 19 L3 6 L13 6" fill="none" stroke="${M}" stroke-width="1.6"/><path d="M12 20 L20 12 L17 9 L9 17 Z" fill="${G}" stroke="currentColor"/><path d="M9 17 L8 21 L12 20" fill="none" stroke="currentColor"/>`);
add('detach', `<path d="M4 4 H20 L12 9 Z" fill="${G}" stroke="currentColor"/><rect x="8" y="13" width="8" height="9" fill="#fff" stroke="currentColor"/><path d="M6 11 H18" stroke="#c03030" stroke-dasharray="2 2"/>`);
add('stairL', `<path d="M3 21 V12 H12 V3 H21 V21 Z" fill="#fff" stroke="currentColor"/><path d="M6 21 V12 M9 21 V12 M12 12 H21 M12 9 H21 M12 6 H21" stroke="currentColor" stroke-width=".8"/>`);
add('stairU', `<path d="M3 21 V3 H21 V21 H14 V9 H10 V21 Z" fill="#fff" stroke="currentColor"/><path d="M3 17 H10 M3 13 H10 M14 17 H21 M14 13 H21" stroke="currentColor" stroke-width=".8"/>`);
add('opening', `<rect x="3" y="3" width="18" height="18" fill="${G}" stroke="currentColor"/><rect x="8" y="8" width="8" height="8" fill="#fff" stroke="currentColor"/>`);
add('attach', `<path d="M4 4 H20 L12 10 Z" fill="${G}" stroke="currentColor"/><rect x="8" y="12" width="8" height="10" fill="#fff" stroke="currentColor"/>`);
