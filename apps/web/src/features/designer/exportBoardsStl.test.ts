import Module, { type ManifoldToplevel } from 'manifold-3d';
import { Buffer } from 'node:buffer';
import { makeDefaultDesign, makeLayerMaterialPolygons } from '@steam-top/domain';
import { beforeAll, describe, expect, it } from 'vitest';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { buildBoardsStl } from './exportBoardsStl';

let kernel: ManifoldToplevel;
beforeAll(async () => { kernel = await Module(); kernel.setup(); });

function inspect(buffer: ArrayBuffer) {
  const geometry = new STLLoader().parse(buffer);
  geometry.computeBoundingBox();
  return geometry;
}

describe('three-board STL', () => {
  it('exports millimetres, 18 mm height, closed outward-oriented edges and no internal faces', () => {
    const design = makeDefaultDesign();
    const buffer = buildBoardsStl(design, kernel);
    const view = new DataView(buffer);
    expect(buffer.byteLength).toBe(84 + view.getUint32(80, true) * 50);
    const geometry = inspect(buffer);
    expect(geometry.boundingBox!.min.z).toBe(0);
    expect(geometry.boundingBox!.max.z).toBe(18);
    const positions = geometry.getAttribute('position');
    const edges = new Map<string, number[]>();
    let signedVolume = 0;
    const polygons = design.layers.map(layer=>makeLayerMaterialPolygons(layer,design));
    const insideLayer = (index: number, x: number, y: number) => polygons[index]!.some(polygon => {
      let inside = false;
      for (const ring of polygon) for (let i=0,j=ring.length-1; i<ring.length; j=i++) {
        const [xi,yi]=ring[i]!, [xj,yj]=ring[j]!;
        if ((yi>y)!==(yj>y) && x<(xj-xi)*(y-yi)/(yj-yi)+xi) inside=!inside;
      }
      return inside;
    });
    for (let i = 0; i < positions.count; i += 3) {
      const [a,b,c] = [0,1,2].map(j=>new Vector3().fromBufferAttribute(positions,i+j)) as [Vector3,Vector3,Vector3];
      signedVolume += a.dot(new Vector3().crossVectors(b,c))/6;
      if (a.z === b.z && b.z === c.z && (a.z === 6 || a.z === 12)) {
        const centroid = a.clone().add(b).add(c).divideScalar(3);
        const indices = a.z === 6 ? [2,1] : [1,0];
        expect(indices.every(index=>insideLayer(index,centroid.x,centroid.y))).toBe(false);
      }
      const points = [0, 1, 2].map(j => [positions.getX(i+j), positions.getY(i+j), positions.getZ(i+j)].join(','));
      for (let j = 0; j < 3; j++) {
        const a = points[j]!, b = points[(j+1)%3]!;
        const key = [a,b].sort().join('|');
        edges.set(key, [...(edges.get(key) ?? []), a < b ? 1 : -1]);
      }
    }
    expect([...edges.values()].every(directions => directions.length === 2 && directions[0]! + directions[1]! === 0)).toBe(true);
    expect(signedVolume).toBeGreaterThan(0);
    geometry.dispose();
  });

  it('keeps layer order and all axle/screw holes, independently of metal discs', () => {
    const design = makeDefaultDesign();
    design.layers.forEach(layer => { layer.shape = 'circle'; });
    const original = buildBoardsStl(design, kernel);
    design.metalDiscDiameterMm = 55;
    expect(Buffer.from(buildBoardsStl(design, kernel)).equals(Buffer.from(original))).toBe(true);
    for (const [index,z] of [[0,15],[1,9],[2,3]] as const) {
      const geometry = inspect(original);
      const material = new MeshBasicMaterial({ side: DoubleSide });
      const mesh = new Mesh(geometry,material);
      mesh.updateMatrixWorld();
      const ray = new Raycaster(new Vector3(-100,0,z),new Vector3(1,0,0));
      const hits = [...new Set(ray.intersectObject(mesh).map(hit => hit.point.x.toFixed(3)))].map(Number);
      expect(Math.max(...hits)-Math.min(...hits)).toBeCloseTo(design.layers[index].diameterMm,2);
      expect(hits).toHaveLength(8); // outer sides + axle and two screw holes
      geometry.dispose(); material.dispose();
    }
    const diameter = design.layers[0].diameterMm;
    design.layers[0].diameterMm = design.layers[2].diameterMm;
    design.layers[2].diameterMm = diameter;
    expect(Buffer.from(buildBoardsStl(design,kernel)).equals(Buffer.from(original))).toBe(false);
  });

  it.each(['star','wave','polygon'] as const)('supports %s with clipped screw holes', shape => {
    const design = makeDefaultDesign();
    design.layers.forEach(layer => { layer.shape=shape; layer.diameterMm=20; layer.points=7; });
    design.screwLayout.radiusMm=9;
    expect(buildBoardsStl(design,kernel).byteLength).toBeGreaterThan(84);
  });

  it('rejects non-finite design input', () => {
    const design = makeDefaultDesign();
    design.layers[0].diameterMm = NaN;
    expect(() => buildBoardsStl(design,kernel)).toThrow();
  });
});
