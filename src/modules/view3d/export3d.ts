// 3D-Export der Modellgeometrie als glTF-Binärdatei (.glb) oder OBJ (+ MTL).
// Ein Knoten je Element (Name = Kategorie/Typ/ID), Einheiten Meter, Y nach oben.
import * as THREE from 'three';
import type { Doc } from '../../core/doc';
import type { View, TypeEl } from '../../core/view';
import { catDef } from '../../core/registry';
import { buildSceneData } from './meshes';

/** three.js-Gruppe des Modells (Meter, Y oben) */
export function exportScene(doc: Doc, view: View, name: string): THREE.Group {
  const data = buildSceneData(doc, view);
  const root = new THREE.Group();
  root.name = name;
  root.rotation.x = -Math.PI / 2;   // Z oben → Y oben
  root.scale.setScalar(0.001);      // mm → m
  const off = new THREE.Group();
  off.position.set(data.origin.x, data.origin.y, data.origin.z);
  root.add(off);
  const mats = data.groups.map((g, i) => new THREE.MeshStandardMaterial({
    name: `m${i}_${g.name.replace(/[^\w\-äöüÄÖÜß]+/g, '_')}`, color: g.color, transparent: g.opacity < 1, opacity: g.opacity, roughness: 0.85, metalness: 0,
  }));
  for (const id of data.ids) {
    const eg = data.els.get(id); const el = doc.get(id);
    if (!eg || !el) continue;
    const node = new THREE.Group();
    const tn = doc.get<TypeEl>(el.typeId)?.name;
    node.name = `${catDef(el.cat)?.label ?? el.cat}${tn ? ' - ' + tn : ''} [${id}]`;
    node.userData = { id, cat: el.cat, mark: el.mark ?? '' };
    for (const p of eg.parts) {
      const g = data.groups[p.g];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos.slice(p.start, p.start + p.count), 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nrm.slice(p.start, p.start + p.count), 3));
      const m = new THREE.Mesh(geo, mats[p.g]);
      m.name = node.name;
      node.add(m);
    }
    off.add(node);
  }
  root.updateMatrixWorld(true);
  return root;
}

export async function toGlb(root: THREE.Object3D): Promise<ArrayBuffer> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  return new Promise((res, rej) => {
    new GLTFExporter().parse(root, (r) => res(r as ArrayBuffer), (e) => rej(e), { binary: true });
  });
}

export async function toObj(root: THREE.Object3D, mtlName: string): Promise<{ obj: string; mtl: string }> {
  const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js');
  const obj = `# OpenRiss OBJ-Export (Meter, Y oben)\nmtllib ${mtlName}\n` + new OBJExporter().parse(root);
  const seen = new Set<string>();
  let mtl = '# OpenRiss Materialien\n';
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!m || !(o as THREE.Mesh).isMesh || seen.has(m.name)) return;
    seen.add(m.name);
    const c = { r: 0, g: 0, b: 0 };
    m.color.getRGB(c, THREE.SRGBColorSpace);
    mtl += `\nnewmtl ${m.name}\nKd ${c.r.toFixed(4)} ${c.g.toFixed(4)} ${c.b.toFixed(4)}\nKa 0 0 0\nd ${m.opacity.toFixed(3)}\nillum 1\n`;
  });
  return { obj, mtl };
}

export function disposeScene(root: THREE.Object3D): void {
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
}
