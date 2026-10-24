import { useEffect, useRef } from "react";

export interface LiveMessage {
  channel: "event" | "status" | "dm" | "chat" | "web" | "memory" | "screen";
  profileId?: number | null;
  payload: any;
}

type Listener = (m: LiveMessage) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let retry = 1000;
/** Which agents' screens this tab wants streamed. */
let screens: "all" | number[] = [];

function sendScreens() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ screens }));
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onmessage = (e) => {
    const m = JSON.parse(e.data) as LiveMessage;
    listeners.forEach((l) => l(m));
  };
  socket.onopen = () => {
    retry = 1000;
    sendScreens();
  };
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

/** Stream screens for the life of a component: one agent's, or every agent's (lower frame rate). */
export function useScreenStream(want: "all" | number) {
  useEffect(() => {
    screens = want === "all" ? "all" : [want];
    sendScreens();
    return () => {
      screens = [];
      sendScreens();
    };
  }, [want]);
}
