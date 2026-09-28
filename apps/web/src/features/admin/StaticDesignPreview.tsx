import { useEffect, useMemo, useRef, useState } from "react";
import { designSchema, MATERIALS } from "@steam-top/domain";
import { BufferGeometry, Color, Euler, ExtrudeGeometry, Vector3 } from "three";
import { makeAcrylicShapes, makeSolidMetalDiscGeometry } from "../designer/preview3DGeometry";
import type { RecordRow } from "./types";

type Face = { points: string; color: string; depth: number };
/** Orthographic, fixed camera: no WebGL contexts or animation loops per record. */
export function projectRecordDesign(record: RecordRow["design"]): Face[] {
  if (record.screwRadiusMm === undefined || record.screwRotationDeg === undefined) throw new Error("MISSING_ASSEMBLY");
  const design = designSchema.parse({
    id: "historical", name: "歷史設計",
    layers: ["top", "middle", "bottom"].map(position => {
      const layer = record.layers.find(value => value.position === position);
      if (!layer) throw new Error("MISSING_LAYER");
      return { id: position, position, shape: layer.shape, points: layer.points ?? 6, diameterMm: layer.diameterMm, cornerRoundness: layer.cornerRoundness, rotationDeg: layer.rotationDeg, color: layer.color ?? "#64748b", ...(layer.outline ? { outline: layer.outline } : {}) };
    }),
    screwLayout: { count: record.layers[0]!.holeCount, radiusMm: record.screwRadiusMm, rotationDeg: record.screwRotationDeg },
    metalDiscDiameterMm: record.metalDiscDiameterMm,
  });
  if (!record.layers.every(layer => layer.holeCount === design.screwLayout.count)) throw new Error("INCONSISTENT_ASSEMBLY");
  const faces: { vertices: Vector3[]; color: string; depth: number }[] = [];
  const rotation = new Euler(-0.85, 0, -0.55);
  const light = new Vector3(-0.3, 0.6, 1).normalize();
  const add = (geometry: BufferGeometry, color: string, z: number) => {
    try {
      const positions = geometry.getAttribute("position");
      const index = geometry.index;
      const size = index?.count ?? positions.count;
      for (let i = 0; i < size; i += 3) {
        const vertices = [0,1,2].map(offset => new Vector3().fromBufferAttribute(positions, index ? index.getX(i + offset) : i + offset).add(new Vector3(0,0,z - 9)).applyEuler(rotation));
        const normal = vertices[1]!.clone().sub(vertices[0]!).cross(vertices[2]!.clone().sub(vertices[0]!)).normalize();
        if (normal.z <= 1e-7) continue;
        faces.push({ vertices, color: new Color(color).multiplyScalar(0.55 + 0.45 * Math.max(0, normal.dot(light))).getStyle(), depth: vertices.reduce((sum, v) => sum + v.z, 0) / 3 });
      }
    } finally { geometry.dispose(); }
  };
  for (const layer of design.layers) {
    add(new ExtrudeGeometry(makeAcrylicShapes(layer, design), { depth: MATERIALS.layerThicknessMm, bevelEnabled: false, curveSegments: 12 }), layer.color, layer.position === "top" ? 12 : layer.position === "middle" ? 6 : 0);
  }
  if (design.metalDiscDiameterMm > 0) add(makeSolidMetalDiscGeometry(design.metalDiscDiameterMm).rotateX(Math.PI / 2), "#8f99a8", -MATERIALS.metalDiscThicknessMm / 2);
  const all = faces.flatMap(face => face.vertices);
  if (!all.length) throw new Error("EMPTY_GEOMETRY");
  const minX = Math.min(...all.map(v => v.x)), maxX = Math.max(...all.map(v => v.x));
  const minY = Math.min(...all.map(v => v.y)), maxY = Math.max(...all.map(v => v.y));
  const scale = Math.min(176 / (maxX-minX), 136 / (maxY-minY));
  return faces.sort((a,b) => a.depth-b.depth).map(face => ({ color: face.color, depth: face.depth, points: face.vertices.map(v => `${(100+(v.x-(minX+maxX)/2)*scale).toFixed(2)},${(80-(v.y-(minY+maxY)/2)*scale).toFixed(2)}`).join(" ") }));
}

export function StaticDesignPreview({ design }: { design: RecordRow["design"] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "120px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const result = useMemo(() => {
    if (!visible) return null;
    try { return projectRecordDesign(design); } catch { return []; }
  }, [design, visible]);
  return <div ref={ref} className="admin-design-preview">
    {result?.length ? <svg role="img" aria-label="歷史陀螺靜態 3D" viewBox="0 0 200 160" width="200" height="160">
      {result.map((face,index) => <polygon key={index} points={face.points} fill={face.color} stroke={face.color} strokeWidth="0.15" />)}
    </svg> : result ? <p>歷史幾何或裝配資料不足，無法重建立體預覽。</p> : <span>3D 預覽</span>}
    {result?.length && design.layers.some(layer => !layer.color) ? <small>舊紀錄未含顏色，以中性色示意</small> : null}
  </div>;
}
