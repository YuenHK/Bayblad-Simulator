import { Canvas, useThree } from "@react-three/fiber";
import {
  ASSEMBLY,
  MATERIALS,
  makeLayerVertices,
  type Layer,
  type TopDesign,
} from "@steam-top/domain";
import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import {
  CylinderGeometry,
  ExtrudeGeometry,
  OrthographicCamera,
  Path,
  Shape,
} from "three";

import { ExplodedView } from "./ExplodedView";
import {
  calculateOrthographicFit,
  calculatePreviewBounds,
  type PreviewBounds,
} from "./previewBounds";
import {
  clampPreviewZoom,
  pointerDistance,
  rotatePreview,
  selectGesturePointers,
  zoomFromPinch,
  type PreviewRotation,
} from "./previewGestures";
import { screwCenters } from "./previewGeometry";

export type TopPreview3DProps = Readonly<{
  design: TopDesign;
  forceFallback?: boolean;
  detectWebGL?: () => boolean;
}>;

export function layerStackZ(position: Layer["position"]): number {
  if (position === "bottom") return 0;
  if (position === "middle") return MATERIALS.layerThicknessMm;
  return MATERIALS.layerThicknessMm * 2;
}

export const METAL_DISC_CENTER_Z = -MATERIALS.metalDiscThicknessMm / 2;

type PreviewErrorBoundaryProps = Readonly<{
  children: ReactNode;
  fallback: ReactNode;
}>;

type PreviewErrorBoundaryState = Readonly<{ failed: boolean }>;

class PreviewErrorBoundary extends Component<
  PreviewErrorBoundaryProps,
  PreviewErrorBoundaryState
> {
  state: PreviewErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): PreviewErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The accessible SVG fallback is rendered locally; the designer stays usable.
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

let cachedWebGLSupport: boolean | undefined;

export function canUseWebGL(): boolean {
  if (cachedWebGLSupport !== undefined) return cachedWebGLSupport;
  if (
    typeof document === "undefined" ||
    typeof window === "undefined" ||
    typeof window.WebGLRenderingContext === "undefined"
  ) {
    cachedWebGLSupport = false;
    return cachedWebGLSupport;
  }
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    cachedWebGLSupport = context !== null;
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return cachedWebGLSupport;
  } catch {
    cachedWebGLSupport = false;
    return cachedWebGLSupport;
  }
}

function Fallback({ design }: Readonly<{ design: TopDesign }>) {
  return (
    <div className="preview-fallback">
      <p role="status">裝置未能啟用 3D，已顯示分解圖</p>
      <ExplodedView design={design} />
    </div>
  );
}

function makeAcrylicShape(layer: Layer, design: TopDesign): Shape {
  const vertices = makeLayerVertices(layer);
  const first = vertices[0];
  const shape = new Shape();
  if (first === undefined) return shape;
  shape.moveTo(first.x, first.y);
  for (const vertex of vertices.slice(1)) shape.lineTo(vertex.x, vertex.y);
  shape.closePath();

  const axle = new Path();
  axle.absarc(0, 0, ASSEMBLY.axleHoleRadiusMm, 0, Math.PI * 2, true);
  shape.holes.push(axle);
  for (const center of screwCenters(design)) {
    const screw = new Path();
    screw.absarc(
      center.x,
      center.y,
      ASSEMBLY.screwHoleRadiusMm,
      0,
      Math.PI * 2,
      true,
    );
    shape.holes.push(screw);
  }
  return shape;
}

function AcrylicLayer({ layer, design }: Readonly<{ layer: Layer; design: TopDesign }>) {
  const shape = useMemo(() => makeAcrylicShape(layer, design), [layer, design.screwLayout]);
  const geometry = useMemo(
    () => new ExtrudeGeometry(shape, {
      depth: MATERIALS.layerThicknessMm,
      bevelEnabled: false,
      curveSegments: 16,
    }),
    [shape],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  const z = layerStackZ(layer.position);

  return (
    <mesh geometry={geometry} position={[0, 0, z]}>
      <meshStandardMaterial color={layer.color} transparent opacity={0.8} roughness={0.36} metalness={0.04} />
    </mesh>
  );
}

function MetalDisc({ diameterMm }: Readonly<{ diameterMm: number }>) {
  const geometry = useMemo(
    () => new CylinderGeometry(
      diameterMm / 2,
      diameterMm / 2,
      MATERIALS.metalDiscThicknessMm,
      64,
    ),
    [diameterMm],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh
      geometry={geometry}
      rotation={[Math.PI / 2, 0, 0]}
      position={[0, 0, METAL_DISC_CENTER_Z]}
    >
      <meshStandardMaterial color="#8f99a8" roughness={0.24} metalness={0.72} />
    </mesh>
  );
}

function PreviewScene({
  design,
  rotation,
  zoom,
  bounds,
}: Readonly<{
  design: TopDesign;
  rotation: PreviewRotation;
  zoom: number;
  bounds: PreviewBounds;
}>) {
  return (
    <>
      <FitOrthographicCamera
        boundingSphereRadiusMm={bounds.boundingSphereRadiusMm}
        userZoom={zoom}
      />
      <ambientLight intensity={1.2} />
      <directionalLight position={[45, -30, 70]} intensity={2.3} />
      <directionalLight position={[-35, 25, 25]} intensity={0.8} />
      <CenteredModel centerZMm={bounds.centerZMm} rotation={rotation}>
        {design.layers.map((layer) => (
          <AcrylicLayer key={layer.id} layer={layer} design={design} />
        ))}
        {design.metalDiscDiameterMm > 0 ? (
          <MetalDisc diameterMm={design.metalDiscDiameterMm} />
        ) : null}
      </CenteredModel>
    </>
  );
}

export function CenteredModel({
  centerZMm,
  rotation,
  children,
}: Readonly<{
  centerZMm: number;
  rotation: PreviewRotation;
  children: ReactNode;
}>) {
  return (
    <group
      name="preview-rotation-pivot"
      rotation={[rotation.x, 0, rotation.y]}
    >
      <group
        name="preview-centered-model"
        position={[0, 0, -centerZMm]}
      >
        {children}
      </group>
    </group>
  );
}

export function FitOrthographicCamera({
  boundingSphereRadiusMm,
  userZoom,
}: Readonly<{
  boundingSphereRadiusMm: number;
  userZoom: number;
}>) {
  const { camera, size } = useThree();

  useLayoutEffect(() => {
    if (
      !(camera instanceof OrthographicCamera) ||
      size.width <= 0 ||
      size.height <= 0
    ) {
      return;
    }
    const fit = calculateOrthographicFit(
      size.width,
      size.height,
      boundingSphereRadiusMm,
    );
    camera.zoom = fit.baseZoom * userZoom;
    camera.updateProjectionMatrix();
  }, [boundingSphereRadiusMm, camera, size.height, size.width, userZoom]);

  return null;
}

type PointerPosition = Readonly<{ x: number; y: number }>;

export function TopPreview3D({
  design,
  forceFallback = false,
  detectWebGL = canUseWebGL,
}: TopPreview3DProps) {
  const [rotation, setRotation] = useState<PreviewRotation>({ x: 0.85, y: -0.55 });
  const [zoom, setZoom] = useState(1);
  const [gestureStatus, setGestureStatus] = useState("可拖動旋轉或雙指縮放");
  const pointers = useRef(new Map<number, PointerPosition>());
  const pinchDistance = useRef<number | null>(null);
  const bounds = useMemo(() => calculatePreviewBounds(design), [design]);
  const fallback = <Fallback design={design} />;
  const webGLAvailable = useMemo(
    () => !forceFallback && detectWebGL(),
    [detectWebGL, forceFallback],
  );

  const finishPointer = useCallback((pointerId: number) => {
    if (!pointers.current.has(pointerId)) return;
    pointers.current.delete(pointerId);
    const active = selectGesturePointers(pointers.current);
    pinchDistance.current = active.length === 2
      ? pointerDistance(active[0], active[1])
      : null;
    setGestureStatus(
      active.length === 0
        ? "可拖動旋轉或雙指縮放"
        : active.length === 1
          ? "正在旋轉預覽"
          : "正在縮放預覽",
    );
  }, []);

  useEffect(() => {
    if (!webGLAvailable) return;
    const finishFromWindow = (event: PointerEvent) => finishPointer(event.pointerId);
    const clearFromBlur = () => {
      pointers.current.clear();
      pinchDistance.current = null;
      setGestureStatus("可拖動旋轉或雙指縮放");
    };
    window.addEventListener("pointerup", finishFromWindow);
    window.addEventListener("pointercancel", finishFromWindow);
    window.addEventListener("blur", clearFromBlur);
    return () => {
      window.removeEventListener("pointerup", finishFromWindow);
      window.removeEventListener("pointercancel", finishFromWindow);
      window.removeEventListener("blur", clearFromBlur);
    };
  }, [finishPointer, webGLAvailable]);

  if (!webGLAvailable) return fallback;

  const beginPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort on older embedded browsers.
    }
    const active = selectGesturePointers(pointers.current);
    pinchDistance.current = active.length >= 2
      ? pointerDistance(active[0]!, active[1]!)
      : null;
    setGestureStatus(active.length >= 2 ? "正在縮放預覽" : "正在旋轉預覽");
  };

  const movePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (previous === undefined) return;
    event.preventDefault();
    const next = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, next);
    const active = selectGesturePointers(pointers.current);
    if (active.length >= 2) {
      const nextDistance = pointerDistance(active[0]!, active[1]!);
      if (pinchDistance.current !== null) {
        setZoom((current) => zoomFromPinch(current, pinchDistance.current!, nextDistance));
      }
      pinchDistance.current = nextDistance;
      setGestureStatus("正在縮放預覽");
      return;
    }
    setRotation((current) => rotatePreview(current, {
      x: next.x - previous.x,
      y: next.y - previous.y,
    }));
    setGestureStatus("正在旋轉預覽");
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    finishPointer(event.pointerId);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer cancellation may already have released capture.
    }
  };

  return (
    <PreviewErrorBoundary fallback={fallback}>
      <div
        className={`preview-3d-controls${pointers.current.size > 0 ? " is-interacting" : ""}`}
        role="group"
        tabIndex={0}
        aria-label="3D 陀螺預覽控制：拖動旋轉，雙指或滾輪縮放"
        onPointerDown={beginPointer}
        onPointerMove={movePointer}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={(event) => finishPointer(event.pointerId)}
        onKeyDown={(event) => {
          const rotationStep = 0.12;
          if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setRotation((current) => ({
              x: current.x + (event.key === "ArrowUp" ? -rotationStep : event.key === "ArrowDown" ? rotationStep : 0),
              y: current.y + (event.key === "ArrowLeft" ? -rotationStep : event.key === "ArrowRight" ? rotationStep : 0),
            }));
            setGestureStatus("已用鍵盤旋轉預覽");
          } else if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            setZoom((current) => clampPreviewZoom(current * 1.12));
            setGestureStatus("已用鍵盤縮放預覽");
          } else if (event.key === "-" || event.key === "_") {
            event.preventDefault();
            setZoom((current) => clampPreviewZoom(current / 1.12));
            setGestureStatus("已用鍵盤縮放預覽");
          }
        }}
        onWheel={(event) => {
          event.preventDefault();
          setZoom((current) => clampPreviewZoom(current * Math.exp(-event.deltaY * 0.0015)));
          setGestureStatus("已用滾輪縮放預覽");
        }}
      >
        <Canvas
          orthographic
          camera={{ position: [0, 0, 150], zoom: 1, near: 0.1, far: 400 }}
          gl={{ antialias: true, alpha: true }}
        >
          <PreviewScene
            design={design}
            rotation={rotation}
            zoom={zoom}
            bounds={bounds}
          />
        </Canvas>
      </div>
      <p className="gesture-hint">單指拖動旋轉，雙指或滾輪縮放</p>
      <p className="sr-only" role="status" aria-live="polite">{gestureStatus}</p>
    </PreviewErrorBoundary>
  );
}
