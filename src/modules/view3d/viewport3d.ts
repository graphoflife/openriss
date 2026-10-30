// 3D-Ansichtsfenster (three.js): Solids als Netze + Körperkanten, Revit-artige Navigation
// (Mausrad = Zoom zum Cursor, Mitteltaste = Verschieben, Umschalt+Mitteltaste = Orbit,
// Doppelklick Mitteltaste = Zoom Grenzen), ViewCube, visuelle Stile, Schnittbereich mit Griffen,
// Auswahl (Klick, Fenster/Kreuzen) und Vorauswahl. Gezeichnet wird nur bei Bedarf.
import * as THREE from 'three';
import { app } from '../../app';
import type { View, Detail } from '../../core/view';
import type { Id, ChangeSet } from '../../core/doc';
import type { V3 } from '../../core/geom';
import { ViewportLike, emitHook } from '../../core/registry';
import { SEL_COLOR, HOVER_COLOR } from '../../render/styles';
import { getTempVis, tempActive, resetTempVis } from '../../views/viewBuilder';
import { bumpTempVis } from '../../views/canvasView';
import { solidsOf } from '../../views/sectionEngine';
import { setViewProp, showMenu, tempHide, tempIsolate } from '../../ui/viewControlBar';
import { icon } from '../../ui/icons';
import { buildSceneData, SceneData, MatGroup } from './meshes';
import { ViewCube } from './viewcube';
import { SectionBox, BoxPanel, BoxDef } from './sectionbox';

export type Style3D = 'wire' | 'hidden' | 'shaded' | 'consistent' | 'realistic';
export const STYLE_LABELS: [Style3D, string][] = [
  ['wire', 'Drahtmodell'], ['hidden', 'Verdeckte Linie'], ['shaded', 'Schattiert'], ['consistent', 'Konsistente Farben'], ['realistic', 'Realistisch'],
];
export interface CamData { eye: V3; target: V3; up: V3; persp: boolean; fov: number }

type DragMode = 'pending-left' | 'pending-right' | 'pending-shift' | 'pan' | 'orbit' | 'box' | 'handle';
interface Drag {
  mode: DragMode; sx: number; sy: number; lx: number; ly: number;
  ctrl: boolean; shift: boolean;
  pivot?: THREE.Vector3; wpp?: number;
  handle?: number; hStart?: number; hOrigin?: THREE.Vector3; t0?: number;
}

const Z = new THREE.Vector3(0, 0, 1);
const vec = (p: V3) => new THREE.Vector3(p.x, p.y, p.z);
const plain = (v: THREE.Vector3): V3 => ({ x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, z: Math.round(v.z * 100) / 100 });
const okV = (p: any): p is V3 => !!p && isFinite(p.x) && isFinite(p.y) && isFinite(p.z);

export class View3D implements ViewportLike {
  view: View;
  el: HTMLElement;
  bar: HTMLElement;
  private stack: HTMLElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private pcam = new THREE.PerspectiveCamera(50, 1, 10, 1e6);
  private ocam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1e6);
  // Kamera (Quelle der Wahrheit, solange die Ansicht offen ist)
  private eye = new THREE.Vector3(20000, -20000, 15000);
  private target = new THREE.Vector3(5000, 2500, 1500);
  private up = new THREE.Vector3(0, 0, 1);
  private persp = false;
  private fov = 50;
  private history: CamData[] = [];
  private anim = 0;
  // Szene
  private data: SceneData | null = null;
  private model = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private edgeLines: THREE.LineSegments | null = null;
  private selObj = new THREE.Group();
  private hoverObj = new THREE.Group();
  private style: Style3D = 'shaded';
  private box = new SectionBox();
  private panel: BoxPanel;
  private cube: ViewCube;
  private amb = new THREE.AmbientLight(0xffffff, 0.8);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x9a9a9a, 1.4);
  private head = new THREE.DirectionalLight(0xffffff, 1.5);
  private sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
  private ground: THREE.Mesh;
  // Zustand
  private geomDirty = true;
  private visKey = '';
  private barKey = '';
  private raf = 0;
  private syncTimer = 0;
  private saveTimer = 0;
  private hover: Id | null = null;
  private hoverPos: { x: number; y: number } | null = null;
  private hoverRaf = 0;
  private drag: Drag | null = null;
  private disposed = false;
  private skipZoom = false;
  private pendingZoom = false;
  private unsub: () => void;
  private ro: ResizeObserver;
  private ray = new THREE.Raycaster();
  private pivotEl: HTMLElement;
  private rectEl: HTMLElement;
  private winListeners: [string, (e: any) => void][] = [];

  constructor(view: View, host: HTMLElement) {
    this.view = view;
    this.el = document.createElement('div');
    this.el.className = 'viewport v3d';
    this.stack = document.createElement('div');
    this.stack.className = 'vp-stack';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'vp-base v3d-canvas';
    this.canvas.tabIndex = -1;
    this.stack.appendChild(this.canvas);
    this.bar = document.createElement('div');
    this.bar.className = 'view-control-bar';
    this.el.append(this.stack, this.bar);
    host.appendChild(this.el);
    this.el.style.display = 'none';
    this.pivotEl = document.createElement('div'); this.pivotEl.className = 'v3d-pivot'; this.pivotEl.style.display = 'none';
    this.rectEl = document.createElement('div'); this.rectEl.className = 'v3d-rect'; this.rectEl.style.display = 'none';
    this.stack.append(this.pivotEl, this.rectEl);

    try {
      const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
      r.setPixelRatio(window.devicePixelRatio || 1);
      r.localClippingEnabled = true;
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer = r;
    } catch (e) {
      console.error(e);
      const msg = document.createElement('div'); msg.className = 'v3d-msg';
      msg.textContent = 'WebGL ist in diesem Browser nicht verfügbar – die 3D-Ansicht kann nicht dargestellt werden.';
      this.stack.appendChild(msg);
    }

    // Szene
    this.hemi.position.set(0, 0, 1);
    this.scene.add(this.amb, this.hemi, this.head, this.head.target, this.sun, this.sun.target);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.22 }));
    this.ground.receiveShadow = true;
    this.scene.add(this.model, this.selObj, this.hoverObj, this.box.group, this.ground);

    this.cube = new ViewCube(this.stack, {
      pick: (dir, up) => this.orientTo(vec(dir).negate(), vec(up)),
      home: () => this.home(),
      menu: (e) => this.cubeMenu(e),
      drag: (dx, dy, end) => {
        if (end) { this.saveCamera(); return; }
        this.stopAnim();
        this.orbitBy(dx, dy, this.modelBox().getCenter(new THREE.Vector3()));
        this.requestRender();
      },
    });
    this.panel = new BoxPanel(this.stack, {
      change: (min, max) => this.commitBox({ on: true, min, max }, 'Schnittbereich ändern'),
      fitSelection: () => this.boxToSelection(),
      fitModel: () => { const b = this.modelBox(false).expandByScalar(300); this.commitBox({ on: true, min: plain(b.min), max: plain(b.max) }, 'Schnittbereich zurücksetzen'); },
      off: () => this.toggleBox(false),
    });

    // Kamera / Schnittbereich aus der Ansicht übernehmen
    const cd = view.data?.camera as CamData | undefined;
    if (cd && okV(cd.eye) && okV(cd.target) && okV(cd.up)) { this.setCam(cd); this.skipZoom = true; }
    else { this.persp = !!cd?.persp; this.eye.copy(this.target).add(new THREE.Vector3(1, -1, 1).normalize().multiplyScalar(30000)); this.fixUp(); }
    this.box.set(view.data?.sectionBox as BoxDef | undefined);
    this.style = (view.style as Style3D) ?? 'shaded';

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.stack);
    this.unsub = app.doc.on((cs) => this.onDocChange(cs));
    app.on('selection', () => { if (!this.disposed) { this.updateHighlight(); this.requestRender(); } });
    app.on('view', () => { if (!this.disposed) this.renderBar(); });
    this.bindEvents();
    this.renderBar();
  }

  // ------------------------------------------------------------ ViewportLike
  activate(): void {
    this.el.style.display = '';
    this.resize();
    this.sync();
    this.renderBar(true);
    if (this.pendingZoom) { this.pendingZoom = false; this.zoomExtents(); }
  }
  deactivate(): void {
    this.el.style.display = 'none';
    this.setHover(null);
    this.drag = null;
    this.pivotEl.style.display = this.rectEl.style.display = 'none';
  }
  invalidate(): void {
    if (this.disposed) return;
    const v = app.doc.get<View>(this.view.id); if (v) this.view = v;
    if (this.syncTimer) return;
    this.syncTimer = window.setTimeout(() => { this.syncTimer = 0; this.sync(); }, 16);
  }
  redrawOverlay(): void { this.requestRender(); }
  dispose(): void {
    this.disposed = true;
    this.saveCamera();
    cancelAnimationFrame(this.raf); cancelAnimationFrame(this.hoverRaf); cancelAnimationFrame(this.anim);
    clearTimeout(this.syncTimer); clearTimeout(this.saveTimer);
    this.unsub(); this.ro.disconnect();
    for (const [n, f] of this.winListeners) window.removeEventListener(n, f);
    this.clearModel();
    this.scene.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); const mt = m.material as THREE.Material | THREE.Material[] | undefined; if (Array.isArray(mt)) mt.forEach((x) => x.dispose()); else mt?.dispose?.(); });
    if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer = null; }
    this.el.remove();
  }
  zoomExtents(): void {
    if (this.skipZoom) { this.skipZoom = false; this.requestRender(); return; }
    if (!this.shown()) { this.pendingZoom = true; return; }
    if (!this.data) this.sync();
    this.pushHistory();
    this.stopAnim();
    const c = this.fitCam(this.zoomBox(), this.dir(), this.up);
    this.eye.copy(c.eye); this.target.copy(c.target);
    this.saveCamera();
    this.requestRender();
  }
  zoomPrevious(): void {
    const c = this.history.pop();
    if (c) { this.setCam({ ...c, persp: this.persp }); this.saveCamera(); this.requestRender(); }
  }
  /** f > 1 vergrößert */
  zoomBy(f: number): void { this.pushHistory(); this.zoomAbout(this.target.clone(), 1 / f); this.saveCamera(); }
  onKey(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && this.drag) { this.endDrag(null, true); return true; }
    return false;
  }

  // ------------------------------------------------------------ Synchronisation mit dem Dokument
  private shown(): boolean { return this.el.style.display !== 'none' && this.canvas.clientWidth > 0; }

  private onDocChange(cs: ChangeSet): void {
    if (this.disposed || this.geomDirty) return;
    for (const set of [cs.added, cs.modified, cs.removed]) for (const id of set) {
      if (id === this.view.id) continue;
      const el = app.doc.get(id);
      if (el && el.cat === 'view') continue;
      this.geomDirty = true; return;
    }
  }

  private visibilityKey(v: View): string {
    const t = getTempVis(v.id);
    return JSON.stringify([v.hiddenCats ?? [], v.hiddenEls ?? [], [...t.hidden], t.isolate ? [...t.isolate] : null, [...t.hiddenCats], t.isolateCats ? [...t.isolateCats] : null, !!t.reveal]);
  }

  private sync(): void {
    if (this.disposed || !this.shown()) return;
    const v = app.doc.get<View>(this.view.id) ?? this.view;
    this.view = v;
    const vk = this.visibilityKey(v);
    if (this.geomDirty || vk !== this.visKey || !this.data) {
      this.geomDirty = false; this.visKey = vk;
      this.rebuild();
    }
    this.applyViewSettings(v);
    this.renderBar();
    this.requestRender();
  }

  private applyViewSettings(v: View): void {
    const st = ((v.style as Style3D) ?? 'shaded');
    if (st !== this.style) { this.style = st; this.applyStyle(); }
    if (!this.drag || this.drag.mode !== 'handle') {
      const wasOn = this.box.on;
      this.box.set(v.data?.sectionBox as BoxDef | undefined);
      if (wasOn !== this.box.on) this.setClipping();
    }
    if (this.panel.visible()) this.panel.fill(this.box.min, this.box.max);
    const p = v.data?.camera?.persp;
    if (typeof p === 'boolean' && p !== this.persp) this.persp = p;
  }

  // ------------------------------------------------------------ Szene aufbauen
  private clearModel(): void {
    for (const m of this.meshes) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.meshes = [];
    if (this.edgeLines) { this.edgeLines.geometry.dispose(); (this.edgeLines.material as THREE.Material).dispose(); this.edgeLines = null; }
    this.model.clear();
    this.clearGroup(this.selObj); this.clearGroup(this.hoverObj);
  }
  private clearGroup(g: THREE.Group): void {
    for (const c of g.children) { const m = c as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material)?.dispose(); }
    g.clear();
  }

  private rebuild(): void {
    let data: SceneData;
    try { data = buildSceneData(app.doc, this.view); } catch (e) { console.error('3D-Ansicht konnte nicht aufgebaut werden', e); return; }
    this.clearModel();
    this.data = data;
    const o = data.origin;
    for (const g of [this.model, this.selObj, this.hoverObj]) g.position.set(o.x, o.y, o.z);
    for (const g of data.groups) {
      if (!g.pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nrm, 3));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.faceMaterial(g));
      mesh.userData = { owners: Int32Array.from(g.owners), group: g };
      mesh.castShadow = mesh.receiveShadow = true;
      if (g.opacity < 1) mesh.renderOrder = 2;
      this.meshes.push(mesh);
      this.model.add(mesh);
    }
    if (data.edges.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(data.edges, 3));
      geo.computeBoundingSphere();
      this.edgeLines = new THREE.LineSegments(geo, this.edgeMaterial());
      this.edgeLines.visible = this.style !== 'realistic';
      this.model.add(this.edgeLines);
    }
    this.scene.updateMatrixWorld(true);
    this.hover = null;
    this.updateHighlight();
    this.updateLights();
  }

  private clipPlanes(): THREE.Plane[] | null { return this.box.on ? this.box.planes : null; }
  /** Materialparameter für den Schnittbereich (ohne Schlüssel, wenn aus – vermeidet three-Warnung) */
  private clipParam(): { clippingPlanes?: THREE.Plane[] } { return this.box.on ? { clippingPlanes: this.box.planes } : {}; }

  private faceMaterial(g: MatGroup): THREE.Material {
    const transparent = g.opacity < 0.99;
    const base = {
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      ...this.clipParam(), clipShadows: true, transparent, opacity: g.opacity, depthWrite: !transparent,
    };
    switch (this.style) {
      case 'wire': return new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
      case 'hidden': return new THREE.MeshBasicMaterial({ ...base, color: 0xffffff, opacity: transparent ? 0.35 : 1 });
      case 'consistent': return new THREE.MeshBasicMaterial({ ...base, color: g.color });
      case 'realistic': return new THREE.MeshStandardMaterial({ ...base, color: g.color, roughness: g.glass ? 0.15 : 0.85, metalness: 0 });
      default: return new THREE.MeshLambertMaterial({ ...base, color: g.color });
    }
  }
  private edgeMaterial(): THREE.LineBasicMaterial {
    return new THREE.LineBasicMaterial({ color: this.style === 'shaded' || this.style === 'consistent' ? 0x1a1a1a : 0x000000, ...this.clipParam() });
  }

  private applyStyle(): void {
    for (const m of this.meshes) { (m.material as THREE.Material).dispose(); m.material = this.faceMaterial(m.userData.group as MatGroup); }
    if (this.edgeLines) {
      (this.edgeLines.material as THREE.Material).dispose();
      this.edgeLines.material = this.edgeMaterial();
      this.edgeLines.visible = this.style !== 'realistic';
    }
    this.updateLights();
  }

  private setClipping(): void {
    const cp = this.clipPlanes();
    const set = (o: THREE.Object3D) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && 'clippingPlanes' in m && (o as THREE.Mesh).geometry) { m.clippingPlanes = cp; m.needsUpdate = true; }
    };
    this.model.traverse(set); this.selObj.traverse(set); this.hoverObj.traverse(set);
  }

  private updateLights(): void {
    const st = this.style;
    const real = st === 'realistic';
    this.amb.intensity = real ? 0.45 : 0.8;
    this.hemi.intensity = real ? 1.25 : 1.4;
    this.hemi.color.set(real ? 0xe4f0ff : 0xffffff);
    this.hemi.groundColor.set(real ? 0x8d7c66 : 0x9a9a9a);
    this.head.intensity = real ? 0.35 : 1.5;
    this.sun.visible = real;
    this.ground.visible = real && !!this.data && !this.data.empty;
    if (!real) return;
    const b = this.modelBox(false);
    const c = b.getCenter(new THREE.Vector3());
    const R = Math.max(1000, b.getSize(new THREE.Vector3()).length() / 2);
    const d = new THREE.Vector3(-0.45, -0.85, 1.1).normalize();
    this.sun.position.copy(c).addScaledVector(d, R * 2);
    this.sun.target.position.copy(c);
    this.sun.target.updateMatrixWorld();
    const sc = this.sun.shadow.camera;
    sc.left = -R * 1.1; sc.right = R * 1.1; sc.top = R * 1.1; sc.bottom = -R * 1.1; sc.near = R * 0.2; sc.far = R * 4;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = R / 3000;
    this.ground.position.set(c.x, c.y, b.min.z - 2);
    this.ground.scale.set(R * 6, R * 6, 1);
  }

  // ------------------------------------------------------------ Hervorhebung
  private highlightObjects(ids: Id[], color: string, fill: number, into: THREE.Group): void {
    this.clearGroup(into);
    if (!this.data || !ids.length) return;
    let nt = 0, ne = 0;
    const gs = ids.map((id) => this.data!.els.get(id)).filter((g): g is NonNullable<typeof g> => !!g);
    if (!gs.length) return;
    for (const g of gs) { nt += g.tris.length; ne += g.edges.length; }
    const tris = new Float32Array(nt), edges = new Float32Array(ne);
    let a = 0, b = 0;
    for (const g of gs) { tris.set(g.tris, a); a += g.tris.length; edges.set(g.edges, b); b += g.edges.length; }
    const cp = this.clipParam();
    if (nt && fill > 0) {
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(tris, 3));
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: fill, depthWrite: false, side: THREE.DoubleSide, ...cp }));
      m.renderOrder = 5;
      into.add(m);
    }
    if (ne) {
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(edges, 3));
      const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, ...cp }));
      l.renderOrder = 6;
      into.add(l);
    }
    into.updateMatrixWorld(true);
  }
  private updateHighlight(): void {
    this.highlightObjects([...app.selection], SEL_COLOR, 0.28, this.selObj);
    this.updateHover();
  }
  private updateHover(): void {
    const h = this.hover && !app.selection.has(this.hover) ? [this.hover] : [];
    this.highlightObjects(h, HOVER_COLOR, 0.12, this.hoverObj);
  }
  private setHover(id: Id | null): void {
    if (id === this.hover) return;
    this.hover = id;
    this.updateHover();
    this.requestRender();
  }

  // ------------------------------------------------------------ Zeichnen
  requestRender(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  private resize(): void {
    const r = this.renderer; if (!r) return;
    const w = this.stack.clientWidth, h = this.stack.clientHeight;
    if (!w || !h) return;
    r.setPixelRatio(window.devicePixelRatio || 1);
    r.setSize(w, h, false);
    if (this.shown() && (!this.data || this.geomDirty)) this.sync();
    if (this.pendingZoom && this.shown()) { this.pendingZoom = false; this.zoomExtents(); }
    this.requestRender();
  }

  private render(): void {
    const r = this.renderer;
    if (!r || this.disposed || !this.shown()) return;
    const cam = this.applyCamera();
    const L = new THREE.Vector3(-0.45, 0.65, 1).applyQuaternion(cam.quaternion).normalize();
    this.head.position.copy(this.target).addScaledVector(L, 1000);
    this.head.target.position.copy(this.target);
    this.head.updateMatrixWorld(); this.head.target.updateMatrixWorld();
    this.box.scaleHandles((p) => this.worldPerPixel(p));
    r.setClearColor(this.style === 'realistic' ? 0xe9eef4 : new THREE.Color(app.settings.background || '#ffffff'), 1);
    r.render(this.scene, cam);
    this.cube.update(cam.quaternion);
    if (this.drag?.mode === 'orbit' && this.drag.pivot) {
      const s = this.toScreen(this.drag.pivot);
      if (s) { this.pivotEl.style.display = ''; this.pivotEl.style.left = s.x + 'px'; this.pivotEl.style.top = s.y + 'px'; }
    }
  }

  /** Bild der Ansicht als PNG-Daten-URL (z. B. für Export/Druck) */
  snapshot(): string {
    const r = this.renderer; if (!r) return '';
    r.render(this.scene, this.applyCamera());
    return this.canvas.toDataURL('image/png');
  }

  // ------------------------------------------------------------ Kamera
  private dir(): THREE.Vector3 { return this.target.clone().sub(this.eye).normalize(); }
  private dist(): number { return Math.max(1e-3, this.eye.distanceTo(this.target)); }
  private aspect(): number { const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1; return w / h; }
  private tanHalf(): number { return Math.tan((this.fov * Math.PI) / 360); }

  /** up orthogonal zur Blickrichtung halten */
  private fixUp(): void {
    const d = this.dir();
    const u = this.up.clone().addScaledVector(d, -this.up.dot(d));
    if (u.lengthSq() < 1e-8) { u.copy(Z).addScaledVector(d, -d.z); if (u.lengthSq() < 1e-8) u.set(0, 1, 0); }
    this.up.copy(u.normalize());
  }
  private camData(): CamData { return { eye: plain(this.eye), target: plain(this.target), up: plain(this.up), persp: this.persp, fov: this.fov }; }
  private setCam(c: CamData): void {
    this.eye.copy(vec(c.eye)); this.target.copy(vec(c.target)); this.up.copy(vec(c.up));
    if (this.eye.distanceTo(this.target) < 1) this.eye.add(new THREE.Vector3(1, -1, 1).multiplyScalar(10000));
    this.persp = !!c.persp;
    this.fov = c.fov > 5 && c.fov < 120 ? c.fov : 50;
    this.fixUp();
  }
  private pushHistory(): void { this.history.push(this.camData()); if (this.history.length > 30) this.history.shift(); }

  /** Kamera in der Ansicht ablegen – bewusst ohne Transaktion (Navigation ist nicht rückgängig zu machen, wie in Revit) */
  private saveCamera(): void {
    const v = app.doc.get<View>(this.view.id);
    if (!v) return;
    v.data = { ...(v.data ?? {}), camera: this.camData() };
  }
  private saveCameraSoon(): void { clearTimeout(this.saveTimer); this.saveTimer = window.setTimeout(() => this.saveCamera(), 400); }

  /** Modellausdehnung (sichtbare Geometrie; optional auf Schnittbereich begrenzt) */
  private modelBox(clip = true): THREE.Box3 {
    const d = this.data;
    const b = d ? new THREE.Box3(vec(d.min), vec(d.max)) : new THREE.Box3(new THREE.Vector3(-5000, -5000, 0), new THREE.Vector3(15000, 10000, 3000));
    if (clip && this.box.on) {
      const sb = new THREE.Box3(this.box.min.clone(), this.box.max.clone());
      const i = b.clone().intersect(sb);
      return i.isEmpty() ? sb : i;
    }
    return b;
  }
  private zoomBox(): THREE.Box3 { return this.modelBox(true); }
  /** Szenengrenzen inkl. Schnittbereich (für Clipping-Ebenen der Kamera) */
  private sceneSphere(): THREE.Sphere {
    const b = this.modelBox(false);
    if (this.box.on) b.union(new THREE.Box3(this.box.min.clone(), this.box.max.clone()));
    return b.getBoundingSphere(new THREE.Sphere());
  }

  private applyCamera(): THREE.Camera {
    const asp = this.aspect();
    const sph = this.sceneSphere();
    const R = Math.max(sph.radius, 1000);
    const dir = this.dir(); const dist = this.dist();
    if (this.persp) {
      const cam = this.pcam;
      cam.position.copy(this.eye); cam.up.copy(this.up); cam.lookAt(this.target);
      cam.fov = this.fov; cam.aspect = asp;
      const dc = sph.center.distanceTo(this.eye);
      cam.far = dc + R * 1.6 + 1000;
      cam.near = Math.max(10, Math.min(dc - R * 1.6, cam.far / 50));
      cam.updateProjectionMatrix(); cam.updateMatrixWorld();
      return cam;
    }
    const cam = this.ocam;
    const h = 2 * dist * this.tanHalf();
    const back = sph.center.distanceTo(this.target) + R * 1.6 + 1000;
    cam.position.copy(this.target).addScaledVector(dir, -back);
    cam.up.copy(this.up); cam.lookAt(this.target);
    cam.left = (-h / 2) * asp; cam.right = (h / 2) * asp; cam.top = h / 2; cam.bottom = -h / 2;
    cam.near = 1; cam.far = back * 2 + 1000;
    cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    return cam;
  }

  private worldPerPixel(p: THREE.Vector3): number {
    const H = this.canvas.clientHeight || 1;
    if (!this.persp) return (2 * this.dist() * this.tanHalf()) / H;
    const depth = Math.max(10, p.clone().sub(this.eye).dot(this.dir()));
    return (2 * depth * this.tanHalf()) / H;
  }

  private toScreen(p: THREE.Vector3): { x: number; y: number } | null {
    const cam = this.applyCamera();
    const v = new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    if (v.w <= 1e-9) return null;
    return { x: ((v.x / v.w + 1) / 2) * this.canvas.clientWidth, y: ((1 - v.y / v.w) / 2) * this.canvas.clientHeight };
  }

  /** Kamera so setzen, dass Box b in Blickrichtung dir vollständig sichtbar ist */
  private fitCam(b: THREE.Box3, dir: THREE.Vector3, up: THREE.Vector3): { eye: THREE.Vector3; target: THREE.Vector3 } {
    const c = b.getCenter(new THREE.Vector3());
    const right = dir.clone().cross(up).normalize();
    const u = right.clone().cross(dir).normalize();
    let hw = 0, hh = 0, hd = 0;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).sub(c);
      hw = Math.max(hw, Math.abs(p.dot(right))); hh = Math.max(hh, Math.abs(p.dot(u))); hd = Math.max(hd, Math.abs(p.dot(dir)));
    }
    hw = Math.max(hw, 500); hh = Math.max(hh, 500);
    const t = this.tanHalf(), asp = this.aspect();
    let dist: number;
    if (this.persp) dist = Math.max(hh / t, hw / (t * asp)) * 1.08 + hd;
    else dist = Math.max(hh, hw / asp) * 1.08 / t;
    return { eye: c.clone().addScaledVector(dir, -dist), target: c };
  }

  private zoomAbout(p: THREE.Vector3, f: number): void {
    f = Math.max(0.2, Math.min(5, f));
    const eye = p.clone().add(this.eye.clone().sub(p).multiplyScalar(f));
    const target = p.clone().add(this.target.clone().sub(p).multiplyScalar(f));
    const d = eye.distanceTo(target);
    if (f < 1 && (d < 20 || (this.persp && eye.distanceTo(p) < 50))) return;
    if (f > 1 && d > 5e7) return;
    this.eye.copy(eye); this.target.copy(target);
    this.requestRender();
  }

  /** Orbit um pivot: dx dreht um die Welt-Z-Achse, dy neigt (Drehtisch wie Revit) */
  private orbitBy(dx: number, dy: number, pivot: THREE.Vector3): void {
    const k = 0.0065;
    const yaw = -dx * k;
    const rot = (axis: THREE.Vector3, ang: number) => {
      this.eye.sub(pivot).applyAxisAngle(axis, ang).add(pivot);
      this.target.sub(pivot).applyAxisAngle(axis, ang).add(pivot);
      this.up.applyAxisAngle(axis, ang);
    };
    if (yaw) rot(Z, yaw);
    const d = this.dir();
    const el = Math.asin(Math.max(-1, Math.min(1, -d.z)));
    const el2 = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, el + dy * k));
    const th = el - el2;
    if (Math.abs(th) > 1e-9) {
      const right = d.clone().cross(this.up).normalize();
      if (right.lengthSq() > 0.5) rot(right, th);
    }
    this.fixUp();
  }

  private stopAnim(): void { if (this.anim) { cancelAnimationFrame(this.anim); this.anim = 0; } }

  /** Weicher Übergang zu einer neuen Kamera */
  private animateTo(eye1: THREE.Vector3, target1: THREE.Vector3, up1: THREE.Vector3, ms = 380): void {
    this.stopAnim();
    const quat = (e: THREE.Vector3, t: THREE.Vector3, u: THREE.Vector3) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(e, t, u));
    const q0 = quat(this.eye, this.target, this.up), q1 = quat(eye1, target1, up1);
    const d0 = this.dist(), d1 = Math.max(1, eye1.distanceTo(target1));
    const t0 = this.target.clone();
    const start = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const q = q0.clone().slerp(q1, e);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      this.up.set(0, 1, 0).applyQuaternion(q);
      this.target.lerpVectors(t0, target1, e);
      this.eye.copy(this.target).addScaledVector(dir, -(d0 + (d1 - d0) * e));
      this.render();
      if (k < 1) this.anim = requestAnimationFrame(step);
      else { this.anim = 0; this.up.copy(up1); this.fixUp(); this.saveCamera(); this.requestRender(); }
    };
    this.anim = requestAnimationFrame(step);
  }

  /** Blickrichtung setzen (ViewCube) und Modell einpassen */
  private orientTo(dir: THREE.Vector3, up: THREE.Vector3): void {
    this.pushHistory();
    const d = dir.clone().normalize();
    const u = up.clone().addScaledVector(d, -up.dot(d)).normalize();
    const c = this.fitCam(this.zoomBox(), d, u);
    this.animateTo(c.eye, c.target, u);
  }
  /** Ausgangsansicht: isometrisch von Südost oben */
  home(): void {
    const d = new THREE.Vector3(-1, 1, -1).normalize();
    this.orientTo(d, Z.clone());
  }

  setPersp(p: boolean, commit = true): void {
    this.persp = p;
    if (commit) {
      const v = app.doc.get<View>(this.view.id);
      if (v) setViewProp(v, { data: { ...(v.data ?? {}), camera: this.camData() } } as Partial<View>, p ? 'Perspektivisch' : 'Orthogonal');
    }
    this.renderBar(); this.requestRender();
  }

  private cubeMenu(e: MouseEvent): void {
    showMenu(e.clientX, e.clientY, [
      ['Zur Ausgangsansicht wechseln', () => this.home()],
      ['Zoom Grenzen', () => this.zoomExtents()],
      '-',
      [(this.persp ? '' : '✓ ') + 'Orthogonal', () => this.setPersp(false)],
      [(this.persp ? '✓ ' : '') + 'Perspektivisch', () => this.setPersp(true)],
      '-',
      ['Blick von oben', () => this.orientTo(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0))],
      ['Blick von vorne (Süd)', () => this.orientTo(new THREE.Vector3(0, 1, 0), Z.clone())],
    ]);
  }

  // ------------------------------------------------------------ Treffer
  private rayAt(sx: number, sy: number): THREE.Raycaster {
    const cam = this.applyCamera();
    const W = this.canvas.clientWidth || 1, H = this.canvas.clientHeight || 1;
    this.ray.setFromCamera(new THREE.Vector2((sx / W) * 2 - 1, -(sy / H) * 2 + 1), cam);
    return this.ray;
  }
  private pick(sx: number, sy: number): { point: THREE.Vector3; id: Id } | null {
    const d = this.data;
    if (!d || !this.meshes.length) return null;
    const hits = this.rayAt(sx, sy).intersectObjects(this.meshes, false);
    for (const h of hits) {
      if (!this.box.contains(h.point)) continue;
      const owners = h.object.userData.owners as Int32Array;
      const id = h.faceIndex != null ? d.ids[owners[h.faceIndex]] : undefined;
      if (id) return { point: h.point.clone(), id };
    }
    return null;
  }
  private planePoint(sx: number, sy: number): THREE.Vector3 {
    const r = this.rayAt(sx, sy);
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(this.dir(), this.target);
    return r.ray.intersectPlane(pl, new THREE.Vector3()) ?? this.target.clone();
  }

  // ------------------------------------------------------------ Maus
  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private onWin<K extends keyof WindowEventMap>(name: K, f: (e: WindowEventMap[K]) => void): void {
    window.addEventListener(name, f as any);
    this.winListeners.push([name, f as any]);
  }

  private bindEvents(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousedown', (e) => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      this.stopAnim();
      const s = this.local(e);
      const base = { sx: s.x, sy: s.y, lx: s.x, ly: s.y, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
      if (e.button === 1) {
        e.preventDefault();
        if (e.shiftKey) this.startOrbit(base); else this.startPan(base);
        return;
      }
      if (e.button === 2) { this.drag = { mode: 'pending-right', ...base }; return; }
      if (e.button !== 0) return;
      // Schnittbereich-Griff?
      const hi = this.box.pickHandle(this.rayAt(s.x, s.y));
      if (hi >= 0) {
        const { axis } = SectionBox.axisOf(hi);
        const origin = this.box.handles[hi].position.clone();
        const ax = new THREE.Vector3(); ax[axis] = 1;
        const t0 = SectionBox.axisParam(this.rayAt(s.x, s.y).ray, origin, ax);
        this.drag = { mode: 'handle', ...base, handle: hi, hStart: origin[axis], hOrigin: origin, t0: t0 ?? 0 };
        return;
      }
      this.drag = { mode: e.shiftKey ? 'pending-shift' : 'pending-left', ...base };
    });
    this.onWin('mousemove', (e) => {
      if (this.disposed || this.el.style.display === 'none') return;
      const d = this.drag;
      if (!d) {
        if (e.target === c && !e.buttons) { this.hoverPos = this.local(e); this.scheduleHover(); }
        return;
      }
      const s = this.local(e);
      const dx = s.x - d.lx, dy = s.y - d.ly;
      const moved = Math.hypot(s.x - d.sx, s.y - d.sy) > 4;
      switch (d.mode) {
        case 'pending-left': if (moved) { d.mode = 'box'; this.updateRect(d, s); } return;
        case 'pending-right': case 'pending-shift': if (moved) { this.startOrbit(d, true); } return;
        case 'box': this.updateRect(d, s); return;
        case 'pan': this.panBy(dx, dy, d.wpp ?? 1); break;
        case 'orbit': this.orbitBy(dx, dy, d.pivot!); this.requestRender(); break;
        case 'handle': this.dragHandle(d, s); break;
      }
      d.lx = s.x; d.ly = s.y;
    });
    this.onWin('mouseup', (e) => {
      if (!this.drag || this.disposed) return;
      this.endDrag(e, false);
    });
    c.addEventListener('auxclick', (e) => { if (e.button === 1 && e.detail === 2) this.zoomExtents(); });
    c.addEventListener('dblclick', () => { /* Doppelklick links: nichts (Bearbeiten erfolgt in 2D) */ });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.stopAnim();
      const s = this.local(e);
      const f = Math.pow(1.0015, e.deltaY * (e.deltaMode === 1 ? 30 : 1));
      const hit = this.pick(s.x, s.y);
      this.zoomAbout(hit ? hit.point : this.planePoint(s.x, s.y), f);
      this.saveCameraSoon();
    }, { passive: false });
    c.addEventListener('mouseleave', () => { this.hoverPos = null; if (!this.drag) this.setHover(null); if (this.box.setHover(-1)) this.requestRender(); });
  }

  private startPan(d: Omit<Drag, 'mode'> & { mode?: DragMode }): void {
    const hit = this.pick(d.sx, d.sy);
    const p = hit ? hit.point : this.planePoint(d.sx, d.sy);
    this.drag = { ...d, mode: 'pan', wpp: this.worldPerPixel(p) };
    this.canvas.style.cursor = 'grabbing';
  }
  private startOrbit(d: Omit<Drag, 'mode'> & { mode?: DragMode }, keep = false): void {
    const hit = this.pick(d.sx, d.sy);
    const pivot = hit ? hit.point : this.modelBox().getCenter(new THREE.Vector3());
    if (keep && this.drag) { this.drag.mode = 'orbit'; this.drag.pivot = pivot; }
    else this.drag = { ...d, mode: 'orbit', pivot };
    this.canvas.style.cursor = 'move';
    this.setHover(null);
  }
  private panBy(dx: number, dy: number, wpp: number): void {
    const right = this.dir().cross(this.up).normalize();
    const t = right.multiplyScalar(-dx * wpp).addScaledVector(this.up, dy * wpp);
    this.eye.add(t); this.target.add(t);
    this.requestRender();
  }

  private updateRect(d: Drag, s: { x: number; y: number }): void {
    const x0 = Math.min(d.sx, s.x), y0 = Math.min(d.sy, s.y);
    const st = this.rectEl.style;
    st.display = ''; st.left = x0 + 'px'; st.top = y0 + 'px';
    st.width = Math.abs(s.x - d.sx) + 'px'; st.height = Math.abs(s.y - d.sy) + 'px';
    this.rectEl.classList.toggle('crossing', s.x < d.sx);
  }

  private dragHandle(d: Drag, s: { x: number; y: number }): void {
    const i = d.handle!;
    const { axis } = SectionBox.axisOf(i);
    const ax = new THREE.Vector3(); ax[axis] = 1;
    const t = SectionBox.axisParam(this.rayAt(s.x, s.y).ray, d.hOrigin!, ax);
    if (t === null) return;
    let val = d.hStart! + (t - d.t0!);
    const minGap = 50;
    if (i & 1) val = Math.max(val, this.box.min[axis] + minGap); else val = Math.min(val, this.box.max[axis] - minGap);
    (i & 1 ? this.box.max : this.box.min)[axis] = Math.round(val);
    this.box.update();
    if (this.panel.visible()) this.panel.fill(this.box.min, this.box.max);
    this.requestRender();
  }

  private endDrag(e: MouseEvent | null, cancel: boolean): void {
    const d = this.drag!;
    this.drag = null;
    this.canvas.style.cursor = '';
    this.pivotEl.style.display = 'none';
    this.rectEl.style.display = 'none';
    if (cancel) { if (d.mode === 'handle') { this.applyViewSettings(this.view); this.requestRender(); } return; }
    const s = e ? this.local(e) : { x: d.lx, y: d.ly };
    switch (d.mode) {
      case 'pan': case 'orbit': this.saveCamera(); this.requestRender(); break;
      case 'handle': this.commitBox(this.box.def(), 'Schnittbereich ändern'); break;
      case 'box': this.boxSelect(d, s); break;
      case 'pending-left': case 'pending-shift': this.clickSelect(s.x, s.y, d.ctrl, d.shift); break;
      case 'pending-right': if (e) emitHook('contextmenu', this, e); break;
    }
  }

  private scheduleHover(): void {
    if (this.hoverRaf) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0;
      const p = this.hoverPos;
      if (!p || this.drag || this.disposed) return;
      const hi = this.box.pickHandle(this.rayAt(p.x, p.y));
      const hc = this.box.setHover(hi);
      this.canvas.style.cursor = hi >= 0 ? 'pointer' : '';
      if (hi >= 0) { this.setHover(null); if (hc) this.requestRender(); return; }
      if (hc) this.requestRender();
      const hit = this.pick(p.x, p.y);
      this.setHover(hit ? hit.id : null);
    });
  }

  // ------------------------------------------------------------ Auswahl
  private clickSelect(sx: number, sy: number, ctrl: boolean, shift: boolean): void {
    const hit = this.pick(sx, sy);
    if (!hit) { if (!ctrl && !shift) app.select([]); return; }
    if (ctrl) app.select([hit.id], 'add');
    else if (shift) app.select([hit.id], 'remove');
    else app.select([hit.id]);
  }

  /** Fenster (links → rechts: vollständig innen) oder Kreuzen (rechts → links: berührt) */
  private boxSelect(d: Drag, s: { x: number; y: number }): void {
    const data = this.data; if (!data) return;
    const crossing = s.x < d.sx;
    const x0 = Math.min(d.sx, s.x), x1 = Math.max(d.sx, s.x), y0 = Math.min(d.sy, s.y), y1 = Math.max(d.sy, s.y);
    const cam = this.applyCamera();
    const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    const o = data.origin;
    const e = m.elements;
    const proj = (x: number, y: number, z: number): [number, number] | null => {
      x += o.x; y += o.y; z += o.z;
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 1e-9) return null;
      const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w, ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      return [((nx + 1) / 2) * W, ((1 - ny) / 2) * H];
    };
    const inside = (p: [number, number]) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
    const segHits = (a: [number, number], b: [number, number]) => {
      if (inside(a) || inside(b)) return true;
      // Liang-Barsky
      let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
      for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]] as [number, number][]) {
        if (Math.abs(p) < 1e-12) { if (q < 0) return false; continue; }
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      }
      return t0 <= t1;
    };
    const found: Id[] = [];
    for (const g of data.els.values()) {
      if (!this.box.intersectsBox(g.min, g.max)) continue;
      const E = g.edges;
      if (!E.length) continue;
      let all = true, any = false;
      for (let i = 0; i < E.length; i += 6) {
        const a = proj(E[i], E[i + 1], E[i + 2]), b = proj(E[i + 3], E[i + 4], E[i + 5]);
        if (!a || !b) { all = false; continue; }
        if (crossing) { if (segHits(a, b)) { any = true; break; } }
        else if (!inside(a) || !inside(b)) { all = false; break; }
      }
      if (crossing ? any : all) found.push(g.id);
    }
    if (d.ctrl) app.select(found, 'add');
    else app.select(found);
  }

  // ------------------------------------------------------------ Schnittbereich
  commitBox(def: BoxDef, name: string): void {
    const v = app.doc.get<View>(this.view.id); if (!v) return;
    this.box.set(def); this.setClipping();
    setViewProp(v, { data: { ...(v.data ?? {}), sectionBox: def } } as Partial<View>, name);
    this.renderBar(); this.requestRender();
  }
  toggleBox(on?: boolean): void {
    const v = app.doc.get<View>(this.view.id); if (!v) return;
    const cur = v.data?.sectionBox as BoxDef | undefined;
    const next = on ?? !cur?.on;
    let def: BoxDef;
    if (next && (!cur || !okV(cur.min) || !okV(cur.max))) {
      const b = this.modelBox(false).expandByScalar(300);
      def = { on: true, min: plain(b.min), max: plain(b.max) };
    } else def = { ...(cur ?? this.box.def()), on: next };
    this.commitBox(def, next ? 'Schnittbereich ein' : 'Schnittbereich aus');
    if (!next) this.panel.show(false);
  }
  showBoxPanel(on = !this.panel.visible()): void {
    if (on && !this.box.on) this.toggleBox(true);
    this.panel.show(on);
    if (on) this.panel.fill(this.box.min, this.box.max);
    this.renderBar(true);
  }
  /** Auswahlrahmen (BX): Schnittbereich auf die Auswahl setzen und einzoomen */
  boxToSelection(): boolean {
    const sel = app.selected().filter((e) => e.cat !== 'view' && e.cat !== 'level' && e.cat !== 'type');
    const b = new THREE.Box3();
    for (const el of sel) {
      const g = this.data?.els.get(el.id);
      if (g) { b.expandByPoint(vec(g.min)); b.expandByPoint(vec(g.max)); continue; }
      for (const s of solidsOf(app.doc, el)) for (const f of s.faces) for (const p of f.pts) b.expandByPoint(vec(p));
    }
    if (b.isEmpty()) { app.status('Zuerst Modellelemente auswählen.'); return false; }
    b.expandByScalar(200);
    this.commitBox({ on: true, min: plain(b.min), max: plain(b.max) }, 'Auswahlrahmen');
    this.pushHistory();
    const c = this.fitCam(this.zoomBox(), this.dir(), this.up);
    this.animateTo(c.eye, c.target, this.up.clone());
    return true;
  }

  // ------------------------------------------------------------ Ansichtssteuerungsleiste
  renderBar(force = false): void {
    if (this.disposed) return;
    const v = app.doc.get<View>(this.view.id) ?? this.view;
    const tv = getTempVis(v.id);
    const key = [v.style, v.detail, this.box.on, this.persp, tempActive(v.id), !!tv.reveal, this.panel.visible()].join('|');
    if (!force && key === this.barKey) return;
    this.barKey = key;
    const bar = this.bar;
    bar.innerHTML = '';
    const btn = (html: string, title: string, on: boolean, fn: (e: MouseEvent) => void, warn = false) => {
      const b = document.createElement('button');
      b.className = 'vcb-btn' + (on ? ' on' : '') + (on && warn ? ' warn' : '');
      b.innerHTML = html; b.title = title; b.onclick = fn;
      bar.appendChild(b);
      return b;
    };
    const lbl = document.createElement('span'); lbl.className = 'vcb-label'; lbl.textContent = this.persp ? 'Perspektivisch' : 'Orthogonal';
    lbl.style.minWidth = '72px';
    bar.appendChild(lbl);
    // Detaillierungsgrad
    const dg = document.createElement('span'); dg.className = 'vcb-group';
    for (const [d, l, sym] of [['coarse', 'Grob', '▭'], ['medium', 'Mittel', '▤'], ['fine', 'Fein', '▦']] as [Detail, string, string][]) {
      const b = document.createElement('button');
      b.className = 'vcb-btn' + (v.detail === d ? ' on' : '');
      b.textContent = sym; b.title = 'Detaillierungsgrad: ' + l;
      b.onclick = () => setViewProp(v, { detail: d }, 'Detaillierungsgrad');
      dg.appendChild(b);
    }
    bar.appendChild(dg);
    // Visueller Stil
    const st = document.createElement('select'); st.className = 'vcb-scale'; st.title = 'Visueller Stil';
    for (const [k, l] of STYLE_LABELS) { const o = document.createElement('option'); o.value = k; o.textContent = l; st.appendChild(o); }
    st.value = (v.style as Style3D) ?? 'shaded';
    st.onchange = () => setViewProp(v, { style: st.value as Style3D }, 'Visueller Stil');
    bar.appendChild(st);
    // Perspektive / Orthogonal
    btn(icon('persp3d', 16), this.persp ? 'Perspektivisch – klicken für orthogonale Darstellung' : 'Orthogonal – klicken für perspektivische Darstellung', this.persp, () => this.setPersp(!this.persp));
    // Schnittbereich
    btn(icon('sectionbox', 16), 'Schnittbereich ein/aus', this.box.on, () => this.toggleBox());
    btn('⚙', 'Schnittbereich bearbeiten (Zahlenwerte)', this.panel.visible(), () => this.showBoxPanel());
    // Zoom Grenzen
    btn(icon('zoom', 16), 'Zoom Grenzen (ZE)', false, () => this.zoomExtents());
    // Temporär ausblenden/isolieren
    const active = tempActive(v.id);
    btn('🕶', 'Temporär ausblenden/isolieren (HH, HI, HR)', active, (e) => {
      showMenu(e.clientX, e.clientY, [
        ['Element isolieren (HI)', () => tempIsolate(v, false)],
        ['Kategorie isolieren (IC)', () => tempIsolate(v, true)],
        ['Element ausblenden (HH)', () => tempHide(v, false)],
        ['Kategorie ausblenden (HC)', () => tempHide(v, true)],
        ['Temporär ausblenden/isolieren zurücksetzen (HR)', () => { resetTempVis(v.id); bumpTempVis(); app.emit('view'); }],
      ]);
    }, true);
    btn('💡', 'Verdeckte Elemente anzeigen (RH)', !!tv.reveal, () => { tv.reveal = !tv.reveal; bumpTempVis(); app.emit('view'); }, true);
    if (active) {
      const t = document.createElement('span'); t.className = 'vcb-temp'; t.textContent = 'Temporär ausblenden/isolieren aktiv';
      bar.appendChild(t);
    }
  }
}
