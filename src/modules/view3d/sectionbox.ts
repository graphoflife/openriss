// Schnittbereich (Revit „3D-Ansicht: Schnittbereich“): sechs Schnittebenen, Darstellung als
// Drahtquader mit Pfeilgriffen auf den Seitenflächen sowie ein kleines Zahlenfeld-Panel.
import * as THREE from 'three';
import type { V3 } from '../../core/geom';
import { fmtLen, parseLen } from '../../core/units';

export interface BoxDef { on: boolean; min: V3; max: V3 }

const HANDLE_COLOR = 0x1e6fd9;
const HANDLE_HOVER = 0xff8a00;

export class SectionBox {
  on = false;
  min = new THREE.Vector3(-5000, -5000, -1000);
  max = new THREE.Vector3(15000, 10000, 8000);
  /** Schnittebenen (Normale zeigt ins Innere) */
  planes: THREE.Plane[] = [0, 1, 2, 3, 4, 5].map(() => new THREE.Plane());
  /** Darstellung (wird nicht geschnitten) */
  group = new THREE.Group();
  handles: THREE.Group[] = [];
  private lines: THREE.LineSegments;
  private hmat: THREE.MeshBasicMaterial[] = [];
  private hovered = -1;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x3a6ea5, transparent: true, opacity: 0.9 }));
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
    // Pfeilgriff: Kegel + Stiel, zeigt in +Y (Einheitsgröße, wird je Bild skaliert)
    const cone = new THREE.ConeGeometry(0.5, 1.0, 16); cone.translate(0, 1.1, 0);
    const stem = new THREE.CylinderGeometry(0.16, 0.16, 0.7, 8); stem.translate(0, 0.35, 0);
    for (let i = 0; i < 6; i++) {
      const m = new THREE.MeshBasicMaterial({ color: HANDLE_COLOR, depthTest: false, transparent: true, opacity: 0.95 });
      this.hmat.push(m);
      const h = new THREE.Group();
      const a = new THREE.Mesh(cone, m), b = new THREE.Mesh(stem, m);
      a.renderOrder = b.renderOrder = 20;
      a.userData.handle = b.userData.handle = i;
      h.add(a, b);
      h.userData.handle = i;
      this.handles.push(h);
      this.group.add(h);
    }
    this.update();
  }

  /** Achse und Richtung eines Griffs: 0/1 = x min/max, 2/3 = y, 4/5 = z */
  static axisOf(i: number): { axis: 'x' | 'y' | 'z'; sign: number } {
    return { axis: (['x', 'y', 'z'] as const)[i >> 1], sign: i & 1 ? 1 : -1 };
  }

  set(def: BoxDef | null | undefined): void {
    this.on = !!def?.on;
    if (def?.min && def?.max) { this.min.set(def.min.x, def.min.y, def.min.z); this.max.set(def.max.x, def.max.y, def.max.z); }
    this.update();
  }
  def(): BoxDef { return { on: this.on, min: v3(this.min), max: v3(this.max) }; }
  contains(p: THREE.Vector3, tol = 1): boolean {
    if (!this.on) return true;
    return p.x >= this.min.x - tol && p.y >= this.min.y - tol && p.z >= this.min.z - tol && p.x <= this.max.x + tol && p.y <= this.max.y + tol && p.z <= this.max.z + tol;
  }
  intersectsBox(mn: V3, mx: V3): boolean {
    if (!this.on) return true;
    return mn.x <= this.max.x && mx.x >= this.min.x && mn.y <= this.max.y && mx.y >= this.min.y && mn.z <= this.max.z && mx.z >= this.min.z;
  }

  update(): void {
    const { min: a, max: b } = this;
    this.planes[0].set(new THREE.Vector3(1, 0, 0), -a.x);
    this.planes[1].set(new THREE.Vector3(-1, 0, 0), b.x);
    this.planes[2].set(new THREE.Vector3(0, 1, 0), -a.y);
    this.planes[3].set(new THREE.Vector3(0, -1, 0), b.y);
    this.planes[4].set(new THREE.Vector3(0, 0, 1), -a.z);
    this.planes[5].set(new THREE.Vector3(0, 0, -1), b.z);
    const c = [
      [a.x, a.y, a.z], [b.x, a.y, a.z], [b.x, b.y, a.z], [a.x, b.y, a.z],
      [a.x, a.y, b.z], [b.x, a.y, b.z], [b.x, b.y, b.z], [a.x, b.y, b.z],
    ];
    const E = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const attr = this.lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    E.forEach(([i, j], k) => { attr.setXYZ(k * 2, c[i][0], c[i][1], c[i][2]); attr.setXYZ(k * 2 + 1, c[j][0], c[j][1], c[j][2]); });
    attr.needsUpdate = true;
    this.lines.geometry.computeBoundingSphere();
    const ctr = a.clone().add(b).multiplyScalar(0.5);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 6; i++) {
      const { axis, sign } = SectionBox.axisOf(i);
      const p = ctr.clone(); p[axis] = sign > 0 ? b[axis] : a[axis];
      const dir = new THREE.Vector3(); dir[axis] = sign;
      this.handles[i].position.copy(p);
      this.handles[i].quaternion.setFromUnitVectors(up, dir);
    }
    this.group.visible = this.on;
  }

  /** Griffgröße konstant in Pixeln halten */
  scaleHandles(worldPerPixel: (p: THREE.Vector3) => number): void {
    for (const h of this.handles) h.scale.setScalar(Math.max(1e-3, worldPerPixel(h.position) * 13));
  }

  setHover(i: number): boolean {
    if (i === this.hovered) return false;
    if (this.hovered >= 0) this.hmat[this.hovered].color.setHex(HANDLE_COLOR);
    this.hovered = i;
    if (i >= 0) this.hmat[i].color.setHex(HANDLE_HOVER);
    return true;
  }

  /** Griff unter dem Strahl */
  pickHandle(ray: THREE.Raycaster): number {
    if (!this.on || !this.group.visible) return -1;
    const hits = ray.intersectObjects(this.handles, true);
    for (const h of hits) { const i = h.object.userData.handle; if (typeof i === 'number') return i; }
    return -1;
  }

  /** Parameter t des nächsten Punkts auf der Griffachse zum Mausstrahl */
  static axisParam(ray: THREE.Ray, origin: THREE.Vector3, axis: THREE.Vector3): number | null {
    const w0 = origin.clone().sub(ray.origin);
    const b = axis.dot(ray.direction);
    const den = 1 - b * b;
    if (den < 1e-6) return null;
    const d = ray.direction.dot(w0), e = axis.dot(w0);
    return (b * d - e) / den;
  }
}

const v3 = (v: THREE.Vector3): V3 => ({ x: Math.round(v.x * 10) / 10, y: Math.round(v.y * 10) / 10, z: Math.round(v.z * 10) / 10 });

// ------------------------------------------------------------ Panel mit Zahlenfeldern
export interface BoxPanelHandlers {
  change(min: V3, max: V3): void;
  fitSelection(): void;
  fitModel(): void;
  off(): void;
}

export class BoxPanel {
  el: HTMLElement;
  private inputs: HTMLInputElement[] = [];
  constructor(parent: HTMLElement, private h: BoxPanelHandlers) {
    this.el = document.createElement('div');
    this.el.className = 'sb3d-panel';
    this.el.style.display = 'none';
    const head = document.createElement('div'); head.className = 'sb3d-head';
    head.innerHTML = '<span>Schnittbereich</span>';
    const close = document.createElement('button'); close.className = 'sb3d-x'; close.textContent = '×'; close.title = 'Panel schließen';
    close.onclick = () => this.show(false);
    head.appendChild(close);
    this.el.appendChild(head);
    const t = document.createElement('table');
    t.innerHTML = '<tr><th></th><th>Min</th><th>Max</th></tr>';
    for (const ax of ['X', 'Y', 'Z']) {
      const tr = document.createElement('tr');
      const th = document.createElement('th'); th.textContent = ax; tr.appendChild(th);
      for (let k = 0; k < 2; k++) {
        const td = document.createElement('td');
        const i = document.createElement('input'); i.type = 'text';
        i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { this.commit(); i.blur(); } if (e.key === 'Escape') i.blur(); });
        i.addEventListener('change', () => this.commit());
        td.appendChild(i); tr.appendChild(td); this.inputs.push(i);
      }
      t.appendChild(tr);
    }
    this.el.appendChild(t);
    const btns = document.createElement('div'); btns.className = 'sb3d-btns';
    const mk = (label: string, tip: string, fn: () => void) => { const b = document.createElement('button'); b.textContent = label; b.title = tip; b.onclick = fn; btns.appendChild(b); };
    mk('Auf Auswahl', 'Schnittbereich an die ausgewählten Elemente anpassen (BX)', () => this.h.fitSelection());
    mk('Auf Modell', 'Schnittbereich auf das gesamte Modell zurücksetzen', () => this.h.fitModel());
    mk('Aus', 'Schnittbereich ausschalten', () => this.h.off());
    this.el.appendChild(btns);
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    this.el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    parent.appendChild(this.el);
  }
  visible(): boolean { return this.el.style.display !== 'none'; }
  show(on: boolean): void { this.el.style.display = on ? '' : 'none'; }
  fill(min: V3, max: V3): void {
    const vals = [min.x, max.x, min.y, max.y, min.z, max.z];
    this.inputs.forEach((i, k) => { if (document.activeElement !== i) i.value = fmtLen(vals[k]); });
  }
  private commit(): void {
    const v = this.inputs.map((i) => parseLen(i.value));
    if (v.some((x) => x === null)) return;
    const n = v as number[];
    const min = { x: Math.min(n[0], n[1]), y: Math.min(n[2], n[3]), z: Math.min(n[4], n[5]) };
    const max = { x: Math.max(n[0], n[1]), y: Math.max(n[2], n[3]), z: Math.max(n[4], n[5]) };
    if (max.x - min.x < 1 || max.y - min.y < 1 || max.z - min.z < 1) return;
    this.h.change(min, max);
  }
}

export const SECTIONBOX_CSS = `
.sb3d-panel { position: absolute; left: 8px; top: 8px; z-index: 7; background: rgba(255,255,255,.96); border: 1px solid #9aa4ae; box-shadow: 1px 2px 8px rgba(0,0,0,.18); font-size: 11px; user-select: none; }
.sb3d-head { display: flex; justify-content: space-between; align-items: center; background: #dfe5eb; padding: 2px 4px 2px 8px; font-weight: 600; border-bottom: 1px solid #c5cbd2; }
.sb3d-x { border: none; background: transparent; cursor: pointer; font-size: 14px; line-height: 14px; padding: 0 4px; }
.sb3d-panel table { border-collapse: collapse; margin: 4px 6px; }
.sb3d-panel th { font-weight: 600; color: #5d6873; padding: 1px 4px; }
.sb3d-panel td input { width: 78px; height: 20px; border: 1px solid #c5cbd2; padding: 0 4px; font-size: 11px; }
.sb3d-panel td input:focus { border-color: #1e6fd9; outline: none; }
.sb3d-btns { display: flex; gap: 4px; padding: 0 6px 6px; }
.sb3d-btns button { flex: 1; height: 22px; border: 1px solid #c5cbd2; background: #f7f8f9; cursor: pointer; font-size: 11px; white-space: nowrap; }
.sb3d-btns button:hover { background: #e7f0fc; border-color: #a9c8f0; }
`;
