import { useSyncExternalStore } from "react";
import {
  checkForUpdate,
  describeUpdateError,
  fetchReleaseHistory,
  hasNativeAppLifecycle,
  installUpdate,
  rollbackToVersion,
  type AppUpdate,
  type ReleaseInfo,
} from "../native/appLifecycle";

export type UpdateSnapshot = {
  availableVersion: string | null;
  checking: boolean;
  installing: boolean;
  history: ReleaseInfo[] | null;
  loadingHistory: boolean;
  historyError: string | null;
  switchingVersion: string | null;
};

let snapshot: UpdateSnapshot = {
  availableVersion: null,
  checking: false,
  installing: false,
  history: null,
  loadingHistory: false,
  historyError: null,
  switchingVersion: null,
};
let availableUpdate: AppUpdate | null = null;
let pendingCheck: Promise<string | null> | null = null;
let pendingHistory: Promise<ReleaseInfo[]> | null = null;
const listeners = new Set<() => void>();

function update(patch: Partial<UpdateSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

async function replaceAvailableUpdate(next: AppUpdate | null) {
  const previous = availableUpdate;
  availableUpdate = next;
  update({ availableVersion: next?.version ?? null });
  if (previous && previous !== next) await previous.close();
}

export const updateStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => snapshot,

  async check(): Promise<string | null> {
    if (!hasNativeAppLifecycle()) return null;
    if (pendingCheck) return pendingCheck;
    update({ checking: true });
    pendingCheck = (async () => {
      const next = await checkForUpdate();
      await replaceAvailableUpdate(next);
      return next?.version ?? null;
    })();
    try {
      return await pendingCheck;
    } finally {
      pendingCheck = null;
      update({ checking: false });
    }
  },

  async install(): Promise<void> {
    const current = availableUpdate;
    if (!current) return;
    update({ installing: true });
    try {
      await installUpdate(current);
    } finally {
      update({ installing: false });
    }
  },

  async loadHistory(force = false): Promise<ReleaseInfo[]> {
    if (snapshot.history && !force) return snapshot.history;
    if (pendingHistory) return pendingHistory;
    update({ loadingHistory: true, historyError: null });
    pendingHistory = (async () => {
      try {
        const history = await fetchReleaseHistory();
        update({ history, loadingHistory: false, historyError: null });
        return history;
      } catch (cause) {
        const err = describeUpdateError(cause);
        update({ loadingHistory: false, historyError: err });
        throw cause;
      }
    })();
    try {
      return await pendingHistory;
    } finally {
      pendingHistory = null;
    }
  },

  async switchToVersion(version: string): Promise<void> {
    update({ switchingVersion: version });
    try {
      await rollbackToVersion(version);
    } finally {
      update({ switchingVersion: null });
    }
  },
};

export function useUpdateStore(): UpdateSnapshot {
  return useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot);
}
