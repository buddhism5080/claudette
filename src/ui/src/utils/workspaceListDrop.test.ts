import { describe, expect, it } from "vitest";
import {
  physicalPointToClient,
  rectContainsPoint,
  shouldHandleWorkspaceFolderDrop,
} from "./workspaceListDrop";

const list = { left: 0, top: 40, right: 280, bottom: 800 };

describe("workspace list folder drop", () => {
  it("converts physical pixels to CSS pixels", () => {
    expect(physicalPointToClient({ x: 20, y: 40 }, 2)).toEqual({ x: 10, y: 20 });
    expect(physicalPointToClient({ x: 8, y: 8 }, 0)).toEqual({ x: 8, y: 8 });
  });

  it("accepts a drop inside the workspace list", () => {
    expect(
      shouldHandleWorkspaceFolderDrop({ x: 100, y: 200 }, list, 1),
    ).toBe(true);
    expect(rectContainsPoint(list, { x: 0, y: 40 })).toBe(true);
    expect(rectContainsPoint(list, { x: 280, y: 800 })).toBe(true);
  });

  it("ignores a drop outside the workspace list", () => {
    expect(
      shouldHandleWorkspaceFolderDrop({ x: 400, y: 200 }, list, 1),
    ).toBe(false);
    expect(
      shouldHandleWorkspaceFolderDrop({ x: 800, y: 100 }, list, 2),
    ).toBe(false);
  });

  it("scales the drop point before hit-testing", () => {
    // Physical (100, 200) at dpr 2 is client (50, 100), which is inside.
    expect(
      shouldHandleWorkspaceFolderDrop({ x: 100, y: 200 }, list, 2),
    ).toBe(true);
  });

  it("ignores a drop when the list rect is missing", () => {
    expect(shouldHandleWorkspaceFolderDrop({ x: 10, y: 10 }, null, 1)).toBe(
      false,
    );
    expect(shouldHandleWorkspaceFolderDrop(undefined, list, 1)).toBe(false);
  });
});
