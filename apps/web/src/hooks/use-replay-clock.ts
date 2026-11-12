import { useEffect, useEffectEvent } from "react";
/** Timer ownership follows playback state and is cleaned up on pause/unmount. */
export function useReplayClock(playing: boolean, advance: () => void) {
  const tick = useEffectEvent(advance);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => tick(), 700);
    return () => clearInterval(timer);
  }, [playing]);
}
