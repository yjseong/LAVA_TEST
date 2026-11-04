"use client";
import { useEffect, useState } from "react";

/** useState that remembers its value in the browser (the Dash switch / select had persistence="local"). */
export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial; // private mode, blocked storage, bad JSON
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: the setting simply is not remembered */
    }
  }, [key, value]);
  return [value, setValue] as const;
}
