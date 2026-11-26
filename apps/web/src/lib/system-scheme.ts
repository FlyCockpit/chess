/**
 * Keeps `root`'s `dark` class in step with the OS colour scheme, live: the local lab
 * has no theme toggle, so it follows the system like the app's default ("system").
 * Returns a function that stops following.
 */
export function followSystemScheme(
  root: { classList: Pick<DOMTokenList, "toggle"> },
  query: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">,
) {
  const apply = () => root.classList.toggle("dark", query.matches);
  apply();
  query.addEventListener("change", apply);
  return () => query.removeEventListener("change", apply);
}
