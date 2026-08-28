import {
  makeDefaultDesign,
  predictDesignPerformance,
  validateDesign,
  type DesignValidation,
  type Layer,
  type PerformancePrediction,
  type TopDesign,
} from "@steam-top/domain";
import { useMemo, useReducer } from "react";

type LayerPosition = Layer["position"];
type LayerField = Exclude<keyof Layer, "id" | "position">;
type ScrewField = keyof TopDesign["screwLayout"];

export type DesignerAction =
  | Readonly<{
      type: "update-layer";
      position: LayerPosition;
      field: LayerField;
      value: Layer[LayerField];
    }>
  | Readonly<{
      type: "move-layer";
      position: LayerPosition;
      direction: "up" | "down";
    }>
  | Readonly<{
      type: "update-screw-layout";
      field: ScrewField;
      value: number;
    }>
  | Readonly<{
      type: "update-metal-disc";
      value: TopDesign["metalDiscDiameterMm"];
    }>;

export type DesignerState = Readonly<{
  design: TopDesign;
  validation: DesignValidation;
  prediction: PerformancePrediction;
}>;

const POSITIONS = ["top", "middle", "bottom"] as const;

function positionLayers(layers: readonly Layer[]): TopDesign["layers"] {
  const top = layers[0];
  const middle = layers[1];
  const bottom = layers[2];
  if (top === undefined || middle === undefined || bottom === undefined) {
    throw new RangeError("設計必須保留三層層板");
  }
  return [
    { ...top, position: "top" },
    { ...middle, position: "middle" },
    { ...bottom, position: "bottom" },
  ];
}

function replaceLayer(
  design: TopDesign,
  position: LayerPosition,
  field: LayerField,
  value: Layer[LayerField],
): TopDesign {
  const nextLayers = design.layers.map((layer) =>
    layer.position === position ? { ...layer, [field]: value } : layer,
  );
  return {
    ...design,
    layers: positionLayers(nextLayers),
  };
}

function moveLayer(
  design: TopDesign,
  position: LayerPosition,
  direction: "up" | "down",
): TopDesign {
  const currentIndex = POSITIONS.indexOf(position);
  const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= design.layers.length) {
    return design;
  }

  const reordered = [...design.layers];
  [reordered[currentIndex], reordered[targetIndex]] = [
    reordered[targetIndex]!,
    reordered[currentIndex]!,
  ];
  return {
    ...design,
    layers: positionLayers(reordered),
  };
}

function designerReducer(design: TopDesign, action: DesignerAction): TopDesign {
  switch (action.type) {
    case "update-layer":
      return replaceLayer(
        design,
        action.position,
        action.field,
        action.value,
      );
    case "move-layer":
      return moveLayer(design, action.position, action.direction);
    case "update-screw-layout":
      return {
        ...design,
        screwLayout: {
          ...design.screwLayout,
          [action.field]: action.value,
        },
      };
    case "update-metal-disc":
      return { ...design, metalDiscDiameterMm: action.value };
  }
}

export function useDesigner(): DesignerState & {
  dispatch: React.Dispatch<DesignerAction>;
} {
  const [design, dispatch] = useReducer(designerReducer, undefined, makeDefaultDesign);
  const validation = useMemo(() => validateDesign(design), [design]);
  const prediction = useMemo(
    () => predictDesignPerformance(design),
    [design],
  );

  return { design, validation, prediction, dispatch };
}
