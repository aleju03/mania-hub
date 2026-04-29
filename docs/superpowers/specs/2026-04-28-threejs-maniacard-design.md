# ThreeJS Maniacard Design

## Goal

Replace the CSS-based Maniacard with a faithful upgraded ThreeJS renderer that keeps the current dynamic card identity while improving render consistency and mobile behavior.

## Context

The current Maniacard is built from React DOM, SVG, Tailwind classes, and a large `maniacard-*` CSS block in `src/styles.css`. It simulates thickness and holo effects with CSS `perspective`, `preserve-3d`, transforms, gradients, blend modes, and animated pseudo-elements. That is visually effective on desktop, but it is expensive and inconsistent on mobile.

The new renderer should use the selected "Layered Physical Card" approach. Pokebox (`https://github.com/selop/pokebox`) is a useful reference for shader-driven card effects, pointer/eye-position uniforms, and ThreeJS scene management, but Mania Hub should implement a smaller renderer suited to one dynamic profile card rather than a full card-box scene.

## Scope

Build a raw ThreeJS renderer wrapped by React:

- React owns app data, lifecycle, loading state, and integration with profile/admin routes.
- ThreeJS owns the canvas, scene, renderer, camera, model, textures, shaders, animation loop, pointer input, and device-orientation input.
- Card faces are dynamic canvas textures, not DOM screenshots and not CSS-rendered card layers.
- Holo, foil, glare, tier flow, edge thickness, lighting, and flip/tilt are ThreeJS material or shader behavior.
- `/admin/maniacard` gains an old-vs-new comparison mode for visual tuning.
- The profile Maniacard tab uses the new renderer once the new card is stable enough to replace the old panel.

## Visual Target

The target is a faithful upgrade, not a redesign. Preserve the recognizable current card:

- Same 5:7 collectible-card silhouette.
- Same front/back concept.
- Same dynamic username, avatar, tier label, stats, star rating, and rarity language.
- Same tier families and rough color identity from `MANIA_TIER_STYLES`.
- Same sense of animated foil, glare, triangular patterning, and premium tiers.

The upgrade is allowed to improve physicality:

- Real card thickness and edge material.
- More believable light response.
- Clearer distinction between face art, foil, glare, and edge.
- Smoother flip/tilt behavior from a single WebGL scene instead of many CSS layers.

## Architecture

Create a focused Maniacard renderer module under `src/components/player/maniacard3d/`.

`ManiaCardPanel` remains the route-facing component API. It computes skills and tier from existing `src/lib/maniacard.ts`, then renders a new ThreeJS-backed panel. During tuning, keep the existing CSS card implementation available for `/admin/maniacard` comparison.

Renderer units:

- `ManiaCard3DPanel.tsx`: React wrapper. Accepts the same user/scores/loading inputs as the current panel, computes render data, creates the canvas host, and owns cleanup.
- `ManiaCardRenderer.ts`: Imperative ThreeJS controller. Creates/disposes renderer, scene, camera, mesh, textures, input handlers, resize observer, and animation loop.
- `cardTexture.ts`: Draws front and back card art into canvas textures from render data. Handles avatar loading, fonts, text fitting, stat rows, stars, badges, tier labels, triangular patterning, and back ornamentation.
- `cardGeometry.ts`: Creates the thin rounded card model and optional overlay planes. Prefer a simple extruded rounded rectangle or bevelled shape with bounded segment counts.
- `cardMaterials.ts`: Builds edge, face, and shader materials. Keeps shader uniforms explicit and easy to tune.
- `cardShaders.ts`: Holo/foil/glare shader strings, with uniforms for time, pointer/gyro light position, tier colors, intensity, and quality profile.
- `interactions.ts`: Pointer drag, inertial settle, click/tap flip, device-orientation permission and calibration, and reduced-motion handling.

## Rendering Model

Use a layered physical model:

- Base card body: a thin rounded 3D mesh with an edge material tinted by tier.
- Front face: canvas texture with static layout content.
- Back face: canvas texture with current back design recreated in canvas drawing.
- Overlay layer: transparent shader plane just above the front face for holo, foil, glare, tier flow, premium effects, and avatar shine.
- The face texture generator should also return simple mask metadata for key regions, at minimum the avatar box, so the overlay shader can emphasize shine in the same visual area as the current CSS card.

The canvas face texture should be generated at `1000x1400` logical pixels, then uploaded as a `CanvasTexture`. This keeps text and icons sharp without relying on DOM layout or CSS blend layers.

## Interaction

Desktop:

- Pointer drag tilts and can rotate/flip the card.
- Idle has subtle float and holo motion.
- Pointer position drives glare/foil uniforms.

Mobile:

- Device orientation drives tilt and light position after user permission where required.
- Touch drag remains available as fallback and manual control.
- Idle is adaptive: after a brief shimmer or settle, reduce continuous animation until the user touches, flips, or gyroscope input changes meaningfully.

Accessibility and preferences:

- Honor `prefers-reduced-motion` by disabling idle float and reducing shader animation.
- Keep DOM-accessible fallback text around the canvas for the username, tier, and stats if the canvas cannot render.
- If WebGL is unavailable, show a non-interactive fallback card or the existing CSS implementation during the migration period.

## Performance

The renderer should avoid recreating ThreeJS objects every frame. Update uniforms and transforms during animation; rebuild textures only when user, scores, tier, avatar, or card data changes.

Quality should be explicit:

- Desktop quality: antialias enabled, capped pixel ratio, richer shader motion.
- Mobile quality: pixel ratio capped more aggressively, fewer shader iterations/layers where visually acceptable, adaptive idle, and no post-processing pipeline unless needed.

The first implementation prioritizes visual fidelity, but it should still include instrumentation hooks for frame time and renderer disposal during development.

## Integration

Keep the public component surface small:

```ts
export function ManiaCardPanel(props: ManiaCardPanelProps): JSX.Element;
```

Internally, `ManiaCardPanel` can choose the ThreeJS panel by default. Preserve the current CSS implementation under a separate internal name, such as `CssManiaCardPanel`, while `/admin/maniacard` displays both old and new cards side by side.

Do not move osu! API access or credentials into client rendering code. The renderer receives already-shaped `user`, `scores`, computed skills, and tier style data.

## Testing

Add focused unit tests for deterministic render data and texture layout helpers:

- Long usernames are fitted/truncated without exceeding their box.
- Tier style mapping produces stable renderer colors and labels.
- Stat values and star averages map into expected canvas draw inputs.
- Texture generation handles missing avatar image by drawing a fallback.
- Reduced-motion and mobile quality settings produce expected renderer config.

Use build verification for route and SSR boundaries:

- `npm run test` for library/helper coverage.
- `npm run build` after route/component integration.

Manual visual verification is required:

- `/admin/maniacard` old/new comparison on desktop width.
- Mobile viewport with touch drag.
- Mobile/device-orientation behavior where hardware/browser support exists.
- Flip to back and return to front.
- WebGL unavailable fallback if feasible to simulate.

## Non-Goals

- No full redesign of the Maniacard scoring model.
- No changes to `computeManiaSkills` except if a bug is discovered separately.
- No social-card or OG-image renderer rewrite.
- No moving authenticated osu! API calls to the client.
- No dependency on Pokebox source code or assets.
- No broad route redesign beyond the admin comparison surface.

## Open Implementation Notes

- Add `three` as the core dependency during implementation. Avoid `@react-three/fiber` for the first version so the render loop, disposal, mobile quality caps, and shader uniforms stay explicit.
- Keep initial shader code in `cardShaders.ts` TypeScript strings to avoid adding shader-loader configuration. Extract to `.glsl?raw` only if the files become hard to maintain.
- Use the existing current card as the visual reference throughout tuning, but remove the old CSS card from user-facing profile UI once the ThreeJS renderer is accepted.
