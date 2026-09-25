// 全局应用状态。
//
// 外壳（状态栏、功能区）和页面都需要同一份 `/api/state`。各拉一遍既浪费又容易不同步，
// 所以收成一个极简的订阅式 store：只有一个地方在轮询，谁想读就订阅。
import { useEffect, useState } from "react";

import { getState, type AppState } from "./api";

export interface AppSnapshot {
  state: AppState | null;
  error: string | null;
  /** 首次加载中（还没拿到过任何数据）。 */
  loading: boolean;
}

type Listener = (snapshot: AppSnapshot) => void;

let current: AppSnapshot = { state: null, error: null, loading: true };
let inFlight: Promise<void> | null = null;
const listeners = new Set<Listener>();

function emit(next: AppSnapshot): void {
  current = next;
  for (const listener of listeners) listener(current);
}

/**
 * 拉一次最新状态。
 *
 * 并发调用会合并到同一个请求上——外壳和页面可能同时触发刷新，
 * 没必要真的打两次接口。
 */
export function refreshState(): Promise<void> {
  if (inFlight !== null) return inFlight;

  inFlight = (async () => {
    try {
      const state = await getState();
      emit({ state, error: null, loading: false });
    } catch (error) {
      emit({
        // 失败时保留上一次的数据，界面上只是多一条错误提示，不至于整页空掉
        state: current.state,
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      });
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** 订阅全局状态。组件卸载时自动退订。 */
export function useAppState(): AppSnapshot {
  const [local, setLocal] = useState<AppSnapshot>(current);

  useEffect(() => {
    listeners.add(setLocal);
    // 订阅瞬间可能已经有数据了（别的组件先拉过），同步一次
    setLocal(current);
    return () => {
      listeners.delete(setLocal);
    };
  }, []);

  return local;
}
