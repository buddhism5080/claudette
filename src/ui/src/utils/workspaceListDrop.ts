// Hit-testing for OS file drops onto the sidebar workspace list.
//
// Tauri delivers drag coordinates as physical pixels. `getBoundingClientRect`
// is in CSS pixels, the same frame as `clientX`/`clientY`. Dividing by
// `devicePixelRatio` lines those up. CSS `zoom` is already consistent between
// client coordinates and rects (see `utils/zoom.ts`), so it is not applied
// again here.

export const WORKSPACE_LIST_DROP_SELECTOR = "[data-workspace-list]";

export interface DropPoint {
  x: number;
  y: number;
}

export interface ClientRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function physicalPointToClient(
  position: DropPoint,
  devicePixelRatio: number,
): DropPoint {
  const scale = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { x: position.x / scale, y: position.y / scale };
}

export function rectContainsPoint(rect: ClientRect, point: DropPoint): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

/** True when a Tauri drag-drop point lands inside the workspace list. */
export function shouldHandleWorkspaceFolderDrop(
  position: DropPoint | null | undefined,
  rect: ClientRect | null,
  devicePixelRatio: number,
): boolean {
  if (!position || !rect) return false;
  return rectContainsPoint(rect, physicalPointToClient(position, devicePixelRatio));
}

export function workspaceListClientRect(): ClientRect | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(WORKSPACE_LIST_DROP_SELECTOR);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
  };
}

export function isWorkspaceListFileDrop(
  position: DropPoint | null | undefined,
  devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio,
): boolean {
  return shouldHandleWorkspaceFolderDrop(
    position,
    workspaceListClientRect(),
    devicePixelRatio,
  );
}

export function dragTargetIsWorkspaceList(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return target.closest(WORKSPACE_LIST_DROP_SELECTOR) !== null;
}
