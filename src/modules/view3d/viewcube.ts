// ViewCube (oben rechts): CSS-3D-Würfel, der der Kameradrehung folgt. Jede Würfelseite ist in
// 3×3 Zonen geteilt: Mitte = Seitenansicht, Ränder = Kantenansicht, Ecken = isometrische Ansicht.
// Dazu Home-Symbol (Ausgangsansicht), Ziehen am Würfel = Orbit, Rechtsklick = Menü.
import * as THREE from 'three';
import type { V3 } from '../../core/geom';

interface CubeFace { label: string; n: V3; r: V3; u: V3 }
const FACES: CubeFace[] = [
  { label: 'OBEN', n: { x: 0, y: 0, z: 1 }, r: { x: 1, y: 0, z: 0 }, u: { x: 0, y: 1, z: 0 } },
  { label: 'UNTEN', n: { x: 0, y: 0, z: -1 }, r: { x: 1, y: 0, z: 0 }, u: { x: 0, y: -1, z: 0 } },
  { label: 'VORNE', n: { x: 0, y: -1, z: 0 }, r: { x: 1, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 } },
  { label: 'HINTEN', n: { x: 0, y: 1, z: 0 }, r: { x: -1, y: 0, z: 0 }, u: { x: 0, y: 0, z: 1 } },
  { label: 'RECHTS', n: { x: 1, y: 0, z: 0 }, r: { x: 0, y: 1, z: 0 }, u: { x: 0, y: 0, z: 1 } },
  { label: 'LINKS', n: { x: -1, y: 0, z: 0 }, r: { x: 0, y: -1, z: 0 }, u: { x: 0, y: 0, z: 1 } },
];
const SIZE = 62;
const ZONE_TIP: Record<string, string> = { '0,0': 'Ecke', '1,0': 'Kante', '0,1': 'Kante', '1,1': '' };

export interface ViewCubeHandlers {
  /** Blick aus Richtung dir (vom Ziel zur Kamera), up = Bildschirm-oben */
  pick(dir: V3, up: V3): void;
  home(): void;
  menu(e: MouseEvent): void;
  /** Ziehen am Würfel (Pixel) */
  drag(dx: number, dy: number, end: boolean): void;
}

export class ViewCube {
  el: HTMLElement;
  private scene: HTMLElement;
  private compass: HTMLElement;

  constructor(parent: HTMLElement, private h: ViewCubeHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'vc3d';
    const home = document.createElement('div');
    home.className = 'vc3d-home';
    home.title = 'Ausgangsansicht';
    home.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 11 L12 3 L21 11"/><path d="M5 10 V21 H10 V15 H14 V21 H19 V10" fill="#fff"/></svg>';
    home.onclick = (e) => { e.stopPropagation(); this.h.home(); };
    this.scene = document.createElement('div');
    this.scene.className = 'vc3d-scene';
    // Kompassring in der Grundebene unter dem Würfel (N = +Y)
    this.compass = document.createElement('div');
    this.compass.className = 'vc3d-compass';
    this.compass.style.transform = `matrix3d(1,0,0,0, 0,-1,0,0, 0,0,1,0, 0,0,${-SIZE / 2 - 3},1)`;
    for (const [t, cls] of [['N', 'n'], ['O', 'o'], ['S', 's'], ['W', 'w']]) {
      const s = document.createElement('span'); s.className = 'vc3d-cd vc3d-' + cls; s.textContent = t; this.compass.appendChild(s);
    }
    this.scene.appendChild(this.compass);
    for (const f of FACES) this.scene.appendChild(this.makeFace(f));
    this.el.append(this.scene, home);
    parent.appendChild(this.el);
    this.el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.h.menu(e); });
    this.el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.bindDrag();
  }

  private makeFace(f: CubeFace): HTMLElement {
    const d = document.createElement('div');
    d.className = 'vc3d-face';
    const h = SIZE / 2;
    const m = [f.r.x, f.r.y, f.r.z, 0, -f.u.x, -f.u.y, -f.u.z, 0, f.n.x, f.n.y, f.n.z, 0, f.n.x * h, f.n.y * h, f.n.z * h, 1];
    d.style.transform = `matrix3d(${m.map((x) => +x.toFixed(6)).join(',')})`;
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      const z = document.createElement('div');
      z.className = 'vc3d-z';
      const i = col - 1, k = 1 - row;
      const tip = ZONE_TIP[Math.abs(i) + ',' + Math.abs(k)];
      if (tip) z.title = tip;
      if (i === 0 && k === 0) { z.classList.add('vc3d-c'); z.textContent = f.label; }
      z.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.dragged) return;
        const dir = { x: f.n.x + i * f.r.x + k * f.u.x, y: f.n.y + i * f.r.y + k * f.u.y, z: f.n.z + i * f.r.z + k * f.u.z };
        const l = Math.hypot(dir.x, dir.y, dir.z);
        const dn = { x: dir.x / l, y: dir.y / l, z: dir.z / l };
        // Bildschirm-oben: Z orthogonalisiert, bei Blick von oben/unten die Seiten-Oben-Richtung
        let up = { x: -dn.z * dn.x, y: -dn.z * dn.y, z: 1 - dn.z * dn.z };
        const ul = Math.hypot(up.x, up.y, up.z);
        if (ul < 1e-3) up = { ...f.u }; else up = { x: up.x / ul, y: up.y / ul, z: up.z / ul };
        this.h.pick(dn, up);
      });
      d.appendChild(z);
    }
    return d;
  }

  private dragged = false;
  private bindDrag(): void {
    let start: { x: number; y: number; lx: number; ly: number } | null = null;
    this.scene.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      start = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY };
      this.dragged = false;
      const move = (ev: MouseEvent) => {
        if (!start) return;
        if (!this.dragged && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        this.dragged = true;
        this.h.drag(ev.clientX - start.lx, ev.clientY - start.ly, false);
        start.lx = ev.clientX; start.ly = ev.clientY;
      };
      const up = () => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        if (this.dragged) this.h.drag(0, 0, true);
        start = null;
        setTimeout(() => { this.dragged = false; }, 0);
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
  }

  /** Würfel an die Kameradrehung anpassen */
  update(q: THREE.Quaternion): void {
    // Kamera-Basis in Weltkoordinaten
    const xc = new THREE.Vector3(1, 0, 0).applyQuaternion(q), yc = new THREE.Vector3(0, 1, 0).applyQuaternion(q), zc = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    // Welt → CSS (x rechts, y unten, z zum Betrachter): Zeilen xc, -yc, zc; matrix3d spaltenweise
    const m = [xc.x, -yc.x, zc.x, 0, xc.y, -yc.y, zc.y, 0, xc.z, -yc.z, zc.z, 0, 0, 0, 0, 1];
    this.scene.style.transform = `matrix3d(${m.map((x) => +x.toFixed(6)).join(',')})`;
    this.compass.style.opacity = zc.z > -0.05 ? '1' : '0.3';
  }
}

export const VIEWCUBE_CSS = `
.vc3d { position: absolute; right: 8px; top: 8px; width: 124px; height: 124px; user-select: none; z-index: 6; pointer-events: none; }
.vc3d > * { pointer-events: auto; }
.vc3d-scene { position: absolute; left: 62px; top: 58px; width: 0; height: 0; transform-style: preserve-3d; cursor: grab; }
.vc3d-face { position: absolute; left: -${SIZE / 2}px; top: -${SIZE / 2}px; width: ${SIZE}px; height: ${SIZE}px; box-sizing: border-box;
  backface-visibility: hidden; -webkit-backface-visibility: hidden; background: #eef1f4; border: 1px solid #7d8994;
  display: grid; grid-template-columns: 12px 1fr 12px; grid-template-rows: 12px 1fr 12px; }
.vc3d-z { cursor: pointer; }
.vc3d-z:hover { background: rgba(30, 111, 217, .38); }
.vc3d-c { display: flex; align-items: center; justify-content: center; font: 700 8.5px/1 'Segoe UI', Arial, sans-serif; color: #3a4652; letter-spacing: .2px; overflow: hidden; }
.vc3d-home { position: absolute; left: 0; top: 0; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; color: #4a5560; cursor: pointer; border-radius: 3px; }
.vc3d-home:hover { background: rgba(30, 111, 217, .18); color: #1e6fd9; }
.vc3d-compass { position: absolute; left: -50px; top: -50px; width: 100px; height: 100px; border: 7px solid rgba(140,152,164,.35); border-radius: 50%; box-sizing: border-box; pointer-events: none !important; }
.vc3d-cd { position: absolute; font: 700 9px/12px 'Segoe UI', Arial, sans-serif; color: #55616d; width: 12px; height: 12px; text-align: center; }
.vc3d-n { left: 37px; top: -10px; } .vc3d-s { left: 37px; bottom: -10px; } .vc3d-o { right: -10px; top: 37px; } .vc3d-w { left: -10px; top: 37px; }
`;
