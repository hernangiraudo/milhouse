import { WS_BASE } from "./api";
import type { WsMessage } from "./types";

export function openJobSocket(
  jobId: string,
  onMessage: (m: WsMessage) => void,
  onClose?: () => void,
): WebSocket {
  const url = `${WS_BASE}/api/jobs/${jobId}/ws`;
  const ws = new WebSocket(url);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as WsMessage;
      onMessage(msg);
    } catch {
      // ignore
    }
  };
  ws.onclose = () => {
    onClose?.();
  };
  return ws;
}
