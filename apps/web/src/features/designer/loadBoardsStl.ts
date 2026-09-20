import Module, { type ManifoldToplevel } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { TopDesign } from '@steam-top/domain';
import { buildBoardsStl } from './exportBoardsStl';

let runtime: Promise<ManifoldToplevel> | undefined;
export async function exportBoardsStl(design: TopDesign): Promise<ArrayBuffer> {
  runtime ??= Module({ locateFile: () => wasmUrl }).then(kernel => {
    kernel.setup();
    return kernel;
  }).catch(error => {
    runtime = undefined;
    throw error;
  });
  return buildBoardsStl(design, await runtime);
}
