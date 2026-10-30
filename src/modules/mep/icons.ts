// Symbole (24×24) für das Register «Gebäudetechnik».
import { registerIcon, ICONS } from '../../ui/icons';

const R = '#e02020', Bl = '#1f4fd8', Gn = '#1a9a3a', Or = '#f08000', Br = '#8b4513', M = '#d0209c', G = '#9aa4ae';
const add = (name: string, body: string) => { if (!ICONS[name]) registerIcon(name, body); };

add('mepPipeH', `<path d="M3 9 H15 Q19 9 19 13 V21" fill="none" stroke="${R}" stroke-width="2.4"/><path d="M3 15 H11 Q13 15 13 17 V21" fill="none" stroke="${Bl}" stroke-width="2.4"/>`);
add('mepPipeS', `<path d="M3 8 H21" stroke="${Gn}" stroke-width="2.6"/><path d="M3 14 H21" stroke="${R}" stroke-width="2.6"/><path d="M8 5 L11 8 L8 11" fill="none" stroke="currentColor"/>`);
add('mepDrain', `<path d="M3 7 L21 13" stroke="${Br}" stroke-width="3.2"/><path d="M6 18 H18" stroke="currentColor"/><path d="M15 15 L18 18 L15 21" fill="none" stroke="currentColor"/><text x="5" y="22" font-size="6" fill="currentColor">%</text>`);
add('mepRiser', `<circle cx="12" cy="12" r="6" fill="#fff" stroke="${Br}" stroke-width="2"/><circle cx="12" cy="12" r="1.3" fill="${Br}"/><path d="M16 8 L21 3 M17.5 3 H21 V6.5" fill="none" stroke="currentColor" stroke-width="1.4"/>`);
add('mepDuct', `<path d="M2 8 H14 L20 14 V22" fill="none" stroke="${Gn}" stroke-width="1.6"/><path d="M2 14 H11 L14 17 V22" fill="none" stroke="${Gn}" stroke-width="1.6"/>`);
add('mepVent', `<circle cx="12" cy="12" r="7.5" fill="#fff" stroke="${Gn}" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="${Gn}"/>`);
add('mepAhu', `<rect x="3" y="5" width="18" height="14" fill="#fff" stroke="currentColor"/><path d="M3 5 L21 19 M21 5 L3 19" stroke="${G}"/><path d="M1 8 H3 M1 16 H3" stroke="${Gn}" stroke-width="2"/><path d="M21 8 H23 M21 16 H23" stroke="${Or}" stroke-width="2"/>`);
add('mepConduit', `<path d="M3 18 C8 18 8 6 13 6 S18 12 21 12" fill="none" stroke="${M}" stroke-width="2" stroke-dasharray="3 2"/>`);
add('mepTray', `<path d="M3 9 V15 H21 V9" fill="none" stroke="${M}" stroke-width="1.8"/><path d="M6 12 H18" stroke="${M}" stroke-dasharray="2 2"/>`);
add('mepSocket', `<circle cx="12" cy="13" r="6" fill="#fff" stroke="${M}" stroke-width="1.8"/><path d="M6 13 H18 M12 3 V7" stroke="${M}" stroke-width="1.8"/>`);
add('mepSwitch', `<circle cx="9" cy="14" r="3.5" fill="#fff" stroke="${M}" stroke-width="1.8"/><path d="M11.5 11.5 L18 5 L20 7" fill="none" stroke="${M}" stroke-width="1.8"/>`);
add('mepLight', `<circle cx="12" cy="12" r="8" fill="#fff" stroke="${M}" stroke-width="1.8"/><path d="M6.3 6.3 L17.7 17.7 M17.7 6.3 L6.3 17.7" stroke="${M}" stroke-width="1.8"/>`);
add('mepBoard', `<rect x="4" y="6" width="16" height="12" fill="#fff" stroke="${M}" stroke-width="1.6"/><path d="M4 18 L20 6 V18 Z" fill="${M}"/>`);
add('mepFixture', `<rect x="3" y="7" width="12" height="12" fill="#fff" stroke="currentColor"/><circle cx="17" cy="8" r="4.5" fill="#fff" stroke="${M}" stroke-width="1.5"/><path d="M14 11 L20 5" stroke="${M}"/>`);
add('mepManifold', `<rect x="3" y="7" width="18" height="3" fill="${R}"/><rect x="3" y="14" width="18" height="3" fill="${Bl}"/><path d="M7 10 V14 M12 10 V14 M17 10 V14" stroke="currentColor" stroke-dasharray="1 1"/>`);
add('mepRadiator', `<rect x="3" y="7" width="18" height="10" fill="#fff" stroke="${R}" stroke-width="1.6"/><path d="M7 7 V17 M11 7 V17 M15 7 V17 M19 7 V17" stroke="${R}" stroke-width=".8"/>`);
add('mepHeatPump', `<rect x="3" y="4" width="18" height="16" fill="#fff" stroke="currentColor"/><circle cx="14" cy="12" r="5" fill="none" stroke="${G}"/><text x="7" y="15" font-size="7" fill="${R}" font-weight="bold">WP</text>`);
add('mepTank', `<rect x="7" y="3" width="10" height="18" rx="5" fill="#fff" stroke="currentColor"/><path d="M7 10 H3 M7 16 H3" stroke="${R}" stroke-width="1.6"/><path d="M17 8 H21" stroke="${Gn}" stroke-width="1.6"/>`);
add('mepFloorDrain', `<rect x="5" y="5" width="14" height="14" fill="#fff" stroke="${Br}" stroke-width="1.6"/><circle cx="12" cy="12" r="4" fill="none" stroke="${Br}"/><path d="M8 12 H16 M12 8 V16" stroke="${Br}"/>`);
add('mepConn', `<circle cx="8" cy="12" r="3.2" fill="${Br}"/><circle cx="16" cy="12" r="2.5" fill="${Gn}"/><path d="M3 20 H21" stroke="currentColor"/>`);
add('mepFbh', `<rect x="3" y="3" width="18" height="18" fill="#fff" stroke="${G}" stroke-dasharray="2 1"/><path d="M6 6 H18 V9 H6 V12 H18 V15 H6 V18 H18" fill="none" stroke="${R}" stroke-width="1.4"/>`);
add('mepFbhRoom', `<rect x="3" y="3" width="18" height="18" fill="#e8f0fa" stroke="currentColor"/><path d="M6 6 H18 V10 H6 V14 H18 V18" fill="none" stroke="${R}" stroke-width="1.4"/><path d="M14 13 L19 18 L17 18.5" stroke="currentColor"/>`);
add('mepSchema', `<rect x="2" y="4" width="7" height="6" fill="#fff" stroke="currentColor"/><rect x="15" y="14" width="7" height="6" fill="#fff" stroke="currentColor"/><path d="M9 6 H18 V14" fill="none" stroke="${R}" stroke-width="1.6"/><path d="M9 8 H16 V14" fill="none" stroke="${Bl}" stroke-width="1.6"/><circle cx="18" cy="9" r="2" fill="#fff" stroke="currentColor"/>`);
add('schemaSymbol', `<circle cx="12" cy="12" r="7" fill="#fff" stroke="currentColor" stroke-width="1.6"/><path d="M19 12 L8.5 18 V6 Z" fill="none" stroke="currentColor" stroke-width="1.4"/>`);
add('schemaLine', `<path d="M3 17 H11 V7 H21" fill="none" stroke="${R}" stroke-width="2.4"/><path d="M14 4 L17 7 L14 10" fill="none" stroke="${R}" stroke-width="1.4"/>`);
add('mepSchemaAuto', `<rect x="2" y="9" width="6" height="6" fill="#fff" stroke="currentColor"/><path d="M8 11 H22" stroke="${R}" stroke-width="1.8"/><path d="M8 14 H22" stroke="${Bl}" stroke-width="1.8"/><path d="M14 11 V5 M19 11 V5" stroke="${R}"/><path d="M16 14 V20 M21 14 V20" stroke="${Bl}"/>`);
add('mepPenetrations', `<rect x="3" y="3" width="8" height="18" fill="${G}" stroke="currentColor"/><circle cx="7" cy="12" r="2.6" fill="#fff" stroke="currentColor"/><path d="M1 12 H23" stroke="${Br}" stroke-width="2.4"/><path d="M14 5 L20 5 M17 2 V8" stroke="${R}" stroke-width="1.6"/>`);
add('mepSlope', `<path d="M3 8 L21 15" stroke="${Br}" stroke-width="2.6"/><path d="M5 19 H17" stroke="currentColor"/><path d="M14 16 L17 19 L14 22" fill="none" stroke="currentColor"/><text x="15" y="8" font-size="7" fill="currentColor">2%</text>`);
add('mepList', `<rect x="3" y="3" width="18" height="18" fill="#fff" stroke="currentColor"/><path d="M3 8 H21 M3 13 H21 M3 18 H21 M9 3 V21" stroke="currentColor" stroke-width=".8"/><path d="M11 10.5 H19" stroke="${R}" stroke-width="1.8"/><path d="M11 15.5 H19" stroke="${Gn}" stroke-width="1.8"/>`);
add('mepViews', `<rect x="3" y="3" width="8" height="8" fill="#fff" stroke="${R}"/><rect x="13" y="3" width="8" height="8" fill="#fff" stroke="${Gn}"/><rect x="3" y="13" width="8" height="8" fill="#fff" stroke="${Br}"/><rect x="13" y="13" width="8" height="8" fill="#fff" stroke="${M}"/>`);
add('mepTag', `<path d="M3 16 H14" stroke="${Br}" stroke-width="2.6"/><path d="M8 12 L12 6 H22 V12 H12 Z" fill="#fff" stroke="currentColor"/><text x="14" y="10.5" font-size="4.5" fill="currentColor">Ø110</text>`);
add('mepEarth', `<path d="M3 6 H21 V18 H3 Z" fill="none" stroke="#2e7d32" stroke-width="1.8" stroke-dasharray="5 2 1 2"/><path d="M12 9 V13 M8 13 H16 M9.5 15 H14.5 M11 17 H13" stroke="currentColor" stroke-width="1.4"/>`);
add('mepSanitary', `<rect x="3" y="4" width="18" height="16" rx="3" fill="#fff" stroke="currentColor"/><rect x="6" y="7" width="12" height="10" rx="4" fill="none" stroke="${Br}"/><circle cx="15" cy="12" r="1.2" fill="${Br}"/>`);
