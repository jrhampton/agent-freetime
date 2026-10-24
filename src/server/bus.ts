import { EventEmitter } from "node:events";

/** Everything the UI should see live goes through here and out over the websocket. */
export interface BusMessage {
  channel: "event" | "status" | "dm" | "chat" | "web" | "memory" | "screen";
  profileId?: number | null;
  payload: unknown;
}

class Bus extends EventEmitter {
  publish(msg: BusMessage) {
    this.emit("message", msg);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
