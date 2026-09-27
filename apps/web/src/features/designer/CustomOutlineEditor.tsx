import type {
  CustomOutline,
  OutlineMirrorMode,
  Point,
  TopDesign,
} from "@steam-top/domain";
import { ASSEMBLY } from "@steam-top/domain";
import { useMemo, useRef, useState, type PointerEvent } from "react";
import {
  MAX_RAW_POINTS,
  previewOutline,
  recordStroke,
  redoStroke,
  snappedStroke,
  undoStroke,
  type OutlineDraft,
} from "./customOutlineDraft";
import "./customOutlineEditor.css";

type Props = {
  draft: OutlineDraft;
  onChange: (draft: OutlineDraft) => void;
  onApply: (outline: CustomOutline, diameterMm: number) => void;
  screwLayout?: TopDesign["screwLayout"] | undefined;
  rotationDeg?: number;
};
const coordinates = (points: readonly Point[]) =>
  points.map((p) => `${p.x},${p.y}`).join(" ");
export function CustomOutlineEditor({
  draft,
  onChange,
  onApply,
  screwLayout,
  rotationDeg = 0,
}: Props) {
  const active = useRef<{
    id: number;
    points: Point[];
    overflow: boolean;
  } | null>(null);
  const [drawing, setDrawing] = useState<Point[] | null>(null);
  const preview = useMemo(() => previewOutline(draft), [draft]);
  const snapped = useMemo(() => snappedStroke(draft), [draft]);
  const mode = draft.mirror;
  const guide =
    mode === "none"
      ? "畫一筆閉合輪廓；終點須回到起點 3 mm 內。"
      : mode === "leftRight"
        ? "在右半邊繪畫，兩端回到垂直軸 3 mm 內。"
        : mode === "topBottom"
          ? "在上半邊繪畫，兩端回到水平軸 3 mm 內。"
          : `在 0° 至 ${360 / mode}° 扇區繪畫，兩端分別回到兩條邊界 3 mm 內。`;
  const angle = typeof mode === "number" ? (2 * Math.PI) / mode : 0;
  const pointFromEvent = (event: PointerEvent<SVGSVGElement>): Point => {
    // preserveAspectRatio is xMidYMid meet: account for possible letterboxing.
    const rect = event.currentTarget.getBoundingClientRect();
    const size = Math.min(rect.width, rect.height);
    return {
      x:
        ((event.clientX - rect.left - (rect.width - size) / 2) / size) * 88 -
        44,
      y:
        44 -
        ((event.clientY - rect.top - (rect.height - size) / 2) / size) * 88,
    };
  };
  const append = (event: PointerEvent<SVGSVGElement>) => {
    const stroke = active.current;
    if (!stroke || stroke.id !== event.pointerId || stroke.overflow) return;
    const point = pointFromEvent(event),
      previous = stroke.points.at(-1);
    if (
      previous &&
      Math.hypot(point.x - previous.x, point.y - previous.y) < 0.02
    )
      return;
    if (stroke.points.length >= MAX_RAW_POINTS) {
      stroke.overflow = true;
      return;
    }
    stroke.points.push(point);
  };
  const finish = (event: PointerEvent<SVGSVGElement>, cancelled = false) => {
    if (active.current?.id !== event.pointerId) return;
    append(event);
    const stroke = active.current!;
    active.current = null;
    setDrawing(null);
    onChange(
      recordStroke(
        draft,
        stroke.points,
        cancelled
          ? "筆劃已中斷，請重新繪畫。"
          : stroke.overflow
            ? "筆劃超過 4096 點，請重新繪畫較短筆劃。"
            : undefined,
      ),
    );
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <section className="custom-outline-editor" aria-label="自定造型編輯器">
      <p>
        固定軸心 (0, 0)，單位
        mm。單一封閉外框，可凹入及偏心，不可自行加孔。此處編輯未旋轉的原始輪廓。
      </p>
      <label>
        鏡射方式
        <select
          aria-label="鏡射方式"
          value={mode}
          onChange={(e) =>
            onChange({
              ...draft,
              mirror: (/^\d+$/.test(e.target.value)
                ? Number(e.target.value)
                : e.target.value) as OutlineMirrorMode,
            })
          }
        >
          <option value="none">無鏡射（完整輪廓）</option>
          <option value="leftRight">左右鏡射</option>
          <option value="topBottom">上下鏡射</option>
          {[4, 6, 8, 12].map((n) => (
            <option key={n} value={n}>
              {n} 等分鏡射
            </option>
          ))}
        </select>
      </label>
      <p id="custom-outline-guide">
        {guide} 放開指標後顯示吸附端點；內部筆劃不會自動搬移。
      </p>
      <svg
        className="custom-outline-canvas"
        viewBox="-44 -44 88 88"
        aria-label="自定輪廓畫布"
        aria-describedby="custom-outline-guide"
        role="img"
        onPointerDown={(event) => {
          if (active.current || event.button !== 0) return;
          event.preventDefault();
          active.current = {
            id: event.pointerId,
            points: [pointFromEvent(event)],
            overflow: false,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDrawing([...active.current.points]);
        }}
        onPointerMove={(event) => {
          if (active.current?.id !== event.pointerId) return;
          append(event);
          setDrawing([...active.current.points]);
        }}
        onPointerUp={(event) => finish(event)}
        onPointerCancel={(event) => finish(event, true)}
        onLostPointerCapture={(event) => {
          if (active.current?.id === event.pointerId) finish(event, true);
        }}
      >
        <g
          transform="scale(1 -1)"
          fill="none"
          stroke="currentColor"
          strokeWidth="0.35"
        >
          {mode === "leftRight" ? (
            <path
              d="M 0 -40 H 40 V 40 H 0 Z"
              fill="currentColor"
              fillOpacity="0.06"
            />
          ) : mode === "topBottom" ? (
            <path
              d="M -40 0 H 40 V 40 H -40 Z"
              fill="currentColor"
              fillOpacity="0.06"
            />
          ) : typeof mode === "number" ? (
            <path
              d={`M 0 0 L 40 0 A 40 40 0 0 1 ${40 * Math.cos(angle)} ${40 * Math.sin(angle)} Z`}
              fill="currentColor"
              fillOpacity="0.06"
            />
          ) : null}
          <circle r="40" strokeDasharray="1 1" />
          <path d="M -42 0 H 42 M 0 -42 V 42" strokeDasharray="1 1" />
          <circle r={ASSEMBLY.axleHoleRadiusMm} />
          <circle r="0.5" fill="currentColor" />
          {screwLayout
            ? Array.from({ length: screwLayout.count }, (_, i) => {
                const a =
                  (2 * Math.PI * i) / screwLayout.count +
                  ((screwLayout.rotationDeg - rotationDeg) * Math.PI) / 180;
                return (
                  <circle
                    key={i}
                    cx={screwLayout.radiusMm * Math.cos(a)}
                    cy={screwLayout.radiusMm * Math.sin(a)}
                    r={ASSEMBLY.screwHoleRadiusMm}
                    strokeDasharray="0.6 0.6"
                  />
                );
              })
            : null}
          {!drawing && preview.valid ? (
            <polygon
              points={coordinates(preview.outline.vertices)}
              fill="currentColor"
              fillOpacity="0.1"
              strokeWidth="0.6"
            />
          ) : null}
          <polyline
            points={coordinates(drawing ?? draft.raw)}
            strokeWidth="0.5"
            strokeDasharray={drawing ? undefined : "1 0.5"}
          />
          {!drawing && snapped
            ? [snapped[0]!, snapped[snapped.length - 1]!].map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r="0.8" fill="currentColor" />
              ))
            : null}
        </g>
        <text x="-42" y="43" fill="currentColor" fontSize="3">
          −40 mm
        </text>
        <text x="30" y="43" fill="currentColor" fontSize="3">
          40 mm
        </text>
        <text x="1" y="-40" fill="currentColor" fontSize="3">
          +y
        </text>
      </svg>
      <div className="custom-outline-settings">
        <label>
          簡化程度（mm）
          <input
            aria-label="簡化程度（mm）"
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={draft.simplifyMm}
            onChange={(e) =>
              onChange({ ...draft, simplifyMm: Number(e.target.value) })
            }
          />
          <output>{draft.simplifyMm}</output>
        </label>
        <label>
          平滑程度
          <input
            aria-label="平滑程度"
            type="range"
            min="0"
            max="0.8"
            step="0.1"
            value={draft.smoothing}
            onChange={(e) =>
              onChange({ ...draft, smoothing: Number(e.target.value) })
            }
          />
          <output>{draft.smoothing}</output>
        </label>
      </div>
      <div className="custom-outline-actions">
        <button
          type="button"
          disabled={!draft.past.length || !!drawing}
          onClick={() => onChange(undoStroke(draft))}
        >
          復原筆劃
        </button>
        <button
          type="button"
          disabled={!draft.future.length || !!drawing}
          onClick={() => onChange(redoStroke(draft))}
        >
          重做筆劃
        </button>
        <button
          type="button"
          disabled={!!drawing}
          onClick={() => onChange(recordStroke(draft, []))}
        >
          清除草稿
        </button>
      </div>
      {drawing ? (
        <p role="status">繪畫中；放開後預覽。</p>
      ) : preview.valid ? (
        <p role="status">
          預覽有效：{preview.outline.vertices.length} 點，軸心包絡直徑{" "}
          {preview.diameterMm.toFixed(2)} mm。按「套用自定造型」更新層板。
        </p>
      ) : (
        <p role="alert">{preview.error}</p>
      )}
      <button
        type="button"
        disabled={!preview.valid || !!drawing}
        onClick={() => {
          if (preview.valid) onApply(preview.outline, preview.diameterMm);
        }}
      >
        套用自定造型
      </button>
    </section>
  );
}
