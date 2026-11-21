import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

// `assets/logo.png` is the bare artwork on a transparent canvas, kept outside
// `public/` so it is never served or precached. The transparent icons
// (favicon, pwa-*, also the header logo) use it as is, so they sit on any page
// background. The maskable icon must be opaque, and the generator's default
// fills its padding with white, so it gets the FlyCockpit suite blue instead:
// - maskable: padding 0.27 scales the artwork's farthest opaque pixel inside
//   the center 80% circle (the maskable safe zone).
//
// The apple touch icon is NOT generated here (`sizes: []`): it is the Icon
// Composer tile `assets/app-icon.png` with its transparent corners filled by
// the tile's own background, sampled row by row (a dark vertical gradient),
// and resized to `public/apple-touch-icon-180x180.png` (iOS rounds the corners
// itself, shows transparency as black, and has no dark variant for web clips).
const background = "#4a97fa";

export default defineConfig({
  headLinkOptions: {
    preset: "2023",
  },
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, padding: 0.27, resizeOptions: { background } },
    apple: { ...minimal2023Preset.apple, sizes: [] },
  },
  images: ["assets/logo.png"],
});
