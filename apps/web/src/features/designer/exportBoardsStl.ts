import { designSchema, makeLayerMaterialPolygons, MATERIALS, type TopDesign } from '@steam-top/domain';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';

/** Numeric coordinates are millimetres; STL itself has no unit metadata. */
export function buildBoardsStl(input: TopDesign, kernel: ManifoldToplevel): ArrayBuffer {
  const design = designSchema.parse(input);
  const solids: Manifold[] = [];
  let combined: Manifold | undefined;
  try {
    for (const layer of design.layers) {
      const section = new kernel.CrossSection(makeLayerMaterialPolygons(layer, design).flat(), 'EvenOdd');
      let board: Manifold | undefined;
      try {
        board = section.extrude(MATERIALS.layerThicknessMm);
        const level = { bottom: 0, middle: 1, top: 2 }[layer.position];
        solids.push(board.translate([0, 0, level * MATERIALS.layerThicknessMm]));
      } finally {
        board?.delete();
        section.delete();
      }
    }
    // Union removes coincident internal caps, rather than exporting overlapping shells.
    combined = kernel.Manifold.union(solids);
    if (combined.status() !== 'NoError' || combined.isEmpty()) throw new Error('Invalid board solid');
    const mesh = combined.getMesh();
    const count = mesh.triVerts.length / 3;
    const buffer = new ArrayBuffer(84 + count * 50);
    const bytes = new Uint8Array(buffer);
    bytes.set(new TextEncoder().encode('Bayblad three boards; coordinates=mm; board thickness=6mm; no hardware'));
    const view = new DataView(buffer);
    view.setUint32(80, count, true);
    for (let triangle = 0; triangle < count; triangle++) {
      const points = [0, 1, 2].map(corner => {
        const start = mesh.triVerts[triangle * 3 + corner]! * mesh.numProp;
        return [mesh.vertProperties[start]!, mesh.vertProperties[start + 1]!, mesh.vertProperties[start + 2]!] as const;
      });
      const [a, b, c] = points as [typeof points[number], typeof points[number], typeof points[number]];
      const u = b.map((value, i) => value - a[i]!);
      const v = c.map((value, i) => value - a[i]!);
      const normal = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const length = Math.hypot(...normal);
      if (!(length > 0)) throw new Error('Degenerate STL face');
      const values = [...normal.map(value => value / length), ...a, ...b, ...c];
      values.forEach((value, index) => view.setFloat32(84 + triangle * 50 + index * 4, value, true));
    }
    return buffer;
  } finally {
    combined?.delete();
    solids.forEach(solid => solid.delete());
  }
}
