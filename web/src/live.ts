import { useEffect, useRef } from "react";

export interface LiveMessage {
  channel: "event" | "status" | "dm" | "chat" | "web" | "memory";
  profileId?: number | null;
  payload: any;
}

type Listener = (m: LiveMessage) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let retry = 1000;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data) as LiveMessage;
    listeners.forEach((l) => l(m));
  };
  socket.onopen = () => (retry = 1000);
  socket.onclose = () => {
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 15000);
  };
}

export function startLive() {
  if (!socket) connect();
}

/** Subscribe to live server messages for the life of a component. */
export function useLive(fn: Listener) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l: Listener = (m) => ref.current(m);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
}
