/* Rewarded ads, through Google's Ad Placement API (AdSense for H5 games):
   the player chooses to watch one for a reward. Off unless
   VITE_ADSENSE_CLIENT holds the AdSense publisher id (ca-pub-...);
   VITE_ADSENSE_TEST=1 asks Google for test ads. In dev without an id, a
   stand-in "ad" counts down five seconds so the flow can be played.

   There is no server-side proof that an ad was watched on the web, so a
   reward has to be one a player could take for free without hurting anyone
   (the run's one revive). */

export interface RewardedAd {
  /* Plays the ad; true once it was watched to the end. */
  show: () => Promise<boolean>;
}

const CLIENT = String(import.meta.env.VITE_ADSENSE_CLIENT ?? "").trim();
const TEST = import.meta.env.VITE_ADSENSE_TEST === "1";
const DEV_STAND_IN = !CLIENT && import.meta.env.DEV;

type AdBreakInfo = { breakStatus?: string };
type AdPlacement = Record<string, unknown>;
type AdWindow = Window & { adsbygoogle?: AdPlacement[] };

let loading: Promise<boolean> | null = null;

/* The AdSense script, once a page. False when it can't load (an ad blocker). */
function loadAdApi(): Promise<boolean> {
  if (loading) return loading;
  loading = new Promise((resolve) => {
    const ads = window as AdWindow;
    ads.adsbygoogle = ads.adsbygoogle ?? [];
    const script = document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(CLIENT)}`;
    if (TEST) script.dataset.adbreakTest = "on";
    script.onload = () => {
      ads.adsbygoogle!.push({ preloadAdBreaks: "on", sound: "on" });
      resolve(true);
    };
    script.onerror = () => {
      loading = null;
      resolve(false);
    };
    document.head.appendChild(script);
  });
  return loading;
}

/* Off everywhere, the dev stand-in too, until AdSense approves H5 Games Ads
   for the site; then flip this and set VITE_ADSENSE_CLIENT. */
const REWARDED_ADS_ON = false;

export function rewardedAdsEnabled(): boolean {
  return REWARDED_ADS_ON && (Boolean(CLIENT) || DEV_STAND_IN);
}

/* Asks for an ad; resolves with one ready to show, or null when there is
   none to offer (no fill, blocked, or off). Offer the reward only then. */
export async function prepareRewardedAd(name: string): Promise<RewardedAd | null> {
  if (typeof window === "undefined" || !rewardedAdsEnabled()) return null;
  if (DEV_STAND_IN) return { show: standInAd };
  if (!(await loadAdApi())) return null;
  return new Promise((resolve) => {
    let settled = false;
    let finish: ((viewed: boolean) => void) | null = null;
    let viewed = false;
    const settle = (ad: RewardedAd | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(ad);
    };
    // A blocked or stalled script never calls back.
    const timer = window.setTimeout(() => settle(null), 8000);
    (window as AdWindow).adsbygoogle!.push({
      type: "reward",
      name,
      beforeReward: (showAdFn: () => void) =>
        settle({
          show: () =>
            new Promise<boolean>((done) => {
              finish = done;
              showAdFn();
            }),
        }),
      adViewed: () => {
        viewed = true;
      },
      adDismissed: () => {
        viewed = false;
      },
      adBreakDone: (_info: AdBreakInfo) => {
        settle(null);
        finish?.(viewed);
        finish = null;
      },
    });
  });
}

/* Dev only: a dark screen counting down, skippable for "dismissed". */
function standInAd(): Promise<boolean> {
  return new Promise((resolve) => {
    const cover = document.createElement("div");
    cover.setAttribute("style", "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#0b0b10;color:#f3e9d8;font:700 18px system-ui");
    const label = document.createElement("div");
    const close = document.createElement("button");
    close.textContent = "Close (no reward)";
    close.setAttribute("style", "padding:8px 14px;border:1px solid #f3e9d855;border-radius:8px;background:none;color:inherit;font:inherit;font-size:14px;cursor:pointer");
    cover.append(label, close);
    document.body.appendChild(cover);
    let left = 5;
    const tick = () => {
      label.textContent = `Dev stand-in ad: ${left}`;
    };
    tick();
    const done = (viewed: boolean) => {
      window.clearInterval(timer);
      cover.remove();
      resolve(viewed);
    };
    const timer = window.setInterval(() => {
      left -= 1;
      if (left <= 0) done(true);
      else tick();
    }, 1000);
    close.onclick = () => done(false);
  });
}
