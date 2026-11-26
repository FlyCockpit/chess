import { useEffect, useEffectEvent } from "react";
/**
 * Timer ownership follows playback state and is cleaned up on pause/unmount. A new
 * `delayMs` (an event that needs longer on screen, such as an illegal attempt) restarts
 * the wait from now.
 */
export function useReplayClock(playing: boolean, advance: () => void, delayMs = 700) {
  const tick = useEffectEvent(advance);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => tick(), delayMs);
    return () => clearInterval(timer);
  }, [playing, delayMs]);
}
