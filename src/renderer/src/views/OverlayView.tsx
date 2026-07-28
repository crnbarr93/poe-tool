/**
 * src/renderer/src/views/OverlayView.tsx
 * ======================================
 *
 * THE OVERLAY DOES NOT EXIST. Not a partial one, not a disabled one - none.
 *
 * The design this window is built from draws this view as a screenshot of the game with
 * an overlay composited on top: a grid of layout thumbnails, a "clip saved" toast, and a
 * pill showing a logout hotkey. Every one of those is a picture. There is no overlay
 * window in this build, no layout images, no toast, and - most importantly - no logout
 * macro of any kind.
 *
 * SO THIS VIEW IS A {@link ComingSoon} STATE AND NOTHING ELSE, and the reason is specific
 * rather than tasteful. Static chrome is indistinguishable from working chrome at a
 * glance: a player who sees a layout panel drawn over a screenshot concludes that
 * poe-tool shows layouts, alt-tabs away expecting one, and does not get it. The version
 * of that mistake involving the hotkey pill is worse by an order of magnitude - see the
 * note in `components/ComingSoon.tsx` - which is why nothing resembling a hotkey, a
 * status word or an "armed" indicator appears anywhere below.
 *
 * WHAT IS SAFE TO SAY is what the feature is FOR, in the future tense, so a user can
 * decide whether to wait for it or go and find another tool. That is the entire content
 * of this file.
 *
 * THE NAV ENTRY STAYS. Hiding it would make this explanation unreachable and leave the
 * roadmap invisible; the "Soon" chip beside it is what keeps the signpost from reading as
 * a feature. See the `soon` flag on `NAV_ITEMS` in `App.tsx`.
 *
 * ONE MORE THING THE BULLETS MUST KEEP SAYING: the overlay, when it exists, will still be
 * a separate always-on-top window that draws over the game. It will not inject into the
 * game, read its memory or send it input. That is the app's standing constraint and the
 * place a user is most likely to assume otherwise is precisely a feature described as
 * being "in game".
 */

import type { ReactElement } from 'react'

import { ComingSoon } from '../components/ComingSoon'

export function OverlayView(): ReactElement {
  return (
    <ComingSoon
      title="Overlay"
      description="An always-on-top layer over the game window, so the things you currently alt-tab for are readable without leaving the map: where you are, how long you have been there, and what just happened."
      bullets={[
        'A small always-on-top panel positioned over the game, click-through by default',
        'Layout images for the current campaign zone, matched from the area poe-tool already reads out of Client.txt',
        'Time in the current area, and the death that ended the last one',
        'A brief toast when a clip is saved, so you know it worked without checking the folder',
        'Still read-only: a separate window drawing on top of the game, never anything injected into it, and never any input sent to it'
      ]}
    />
  )
}
