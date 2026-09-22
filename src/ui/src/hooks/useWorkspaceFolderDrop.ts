import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/useAppStore";
import { adoptFolderAsWorkspace } from "../services/tauri";
import type { Repository } from "../types";
import type { Workspace } from "../types/workspace";
import { isWorkspaceListFileDrop } from "../utils/workspaceListDrop";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Drop a folder onto the workspace list: register it under its own name.
 *  Returns whether a folder drag is currently hovering the list, so the
 *  sidebar can show a highlight. Chat drops stay on the chat attachment path. */
export function useWorkspaceFolderDrop(): boolean {
  const { t } = useTranslation("sidebar");
  const tRef = useRef(t);
  tRef.current = t;
  const [active, setActive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let queue: Promise<void> = Promise.resolve();

    const run = async (path: string) => {
      try {
        const result = await adoptFolderAsWorkspace(path);
        if (cancelled) return;
        const store = useAppStore.getState();
        const repo: Repository = {
          ...result.repository,
          remote_connection_id: null,
        };
        const workspace: Workspace = {
          ...result.workspace,
          remote_connection_id: null,
        };
        if (!store.repositories.some((item) => item.id === repo.id)) {
          store.addRepository(repo);
        }
        store.addWorkspace(workspace);
        store.expandRepo(repo.id);
        store.selectWorkspace(workspace.id);
      } catch (err) {
        if (cancelled) return;
        useAppStore
          .getState()
          .addToast(tRef.current("drop_folder_failed", { error: errorText(err) }));
      }
    };

    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => {
        if (cancelled) return;
        return getCurrentWebview().onDragDropEvent((event) => {
          if (cancelled) return;
          if (event.payload.type === "leave") {
            setActive(false);
            return;
          }
          const overList = isWorkspaceListFileDrop(event.payload.position);
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setActive(overList);
            return;
          }
          setActive(false);
          if (!overList) return;
          for (const path of event.payload.paths) {
            const next = path;
            queue = queue.then(
              () => run(next),
              () => run(next),
            );
          }
        });
      })
      .then((fn) => {
        if (!fn) return;
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        if (!cancelled) setActive(false);
      });

    return () => {
      cancelled = true;
      setActive(false);
      unlisten?.();
    };
  }, []);

  return active;
}
