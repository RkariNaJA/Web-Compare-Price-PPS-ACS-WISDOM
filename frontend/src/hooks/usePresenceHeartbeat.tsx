/**
 * While the app is open (mounted, i.e. logged in), tell the backend the current
 * user is active — an immediate ping plus one every `intervalMs`. Powers the
 * admin Log page's "online now" list. Fire-and-forget; failures are ignored.
 */
import { useEffect } from 'react';
import { ping } from '../lib/api';

export function usePresenceHeartbeat(intervalMs = 30000) {
  useEffect(() => {
    ping();
    const id = setInterval(ping, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
