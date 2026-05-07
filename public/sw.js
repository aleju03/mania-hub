const CACHE_NAME = "static-v2";

const PRECACHE_URLS = [
  // Fonts
  "/fonts/Torus-Regular.otf",
  "/fonts/Torus-Heavy.otf",
  "/fonts/Torus-SemiBold.otf",
  "/fonts/Torus-Bold.otf",
  "/fonts/Torus-Light.otf",
  "/fonts/Torus-Thin.otf",
  "/fonts/Venera-500.otf",
  "/fonts/extra.woff2",
  "/fonts/extra.woff",
  "/fonts/extra.ttf",
  // Layout
  "/images/layout/nav2-background-hue0.webp",
  // Grade badges
  "/images/badges/score-ranks-v2019/GradeSmall-SS-Silver.svg",
  "/images/badges/score-ranks-v2019/GradeSmall-SS.svg",
  "/images/badges/score-ranks-v2019/GradeSmall-S-Silver.svg",
  "/images/badges/score-ranks-v2019/GradeSmall-S.svg",
  "/images/badges/score-ranks-v2019/GradeSmall-A.svg",
  "/images/badges/score-ranks-v2019/GradeSmall-B.svg",
  "/images/badges/score-ranks-v2019/GradeSmall-C.svg",
  "/images/badges/score-ranks-v2019/GradeSmall-D.svg",
  "/images/badges/score-ranks-v2019/GradeSmall-F.svg",
  // Mod badges
  "/images/badges/mods/mod-icon.svg",
  "/images/badges/mods/mod-accuracy-challenge.svg",
  "/images/badges/mods/mod-adaptive-speed.svg",
  "/images/badges/mods/mod-alternate.svg",
  "/images/badges/mods/mod-approach-different.svg",
  "/images/badges/mods/mod-autopilot.svg",
  "/images/badges/mods/mod-autoplay.svg",
  "/images/badges/mods/mod-barrel-roll.svg",
  "/images/badges/mods/mod-blinds.svg",
  "/images/badges/mods/mod-bloom.svg",
  "/images/badges/mods/mod-bubbles.svg",
  "/images/badges/mods/mod-cinema.svg",
  "/images/badges/mods/mod-classic.svg",
  "/images/badges/mods/mod-cog-badge.svg",
  "/images/badges/mods/mod-constant-speed.svg",
  "/images/badges/mods/mod-cover.svg",
  "/images/badges/mods/mod-daycore.svg",
  "/images/badges/mods/mod-deflate.svg",
  "/images/badges/mods/mod-depth.svg",
  "/images/badges/mods/mod-difficulty-adjust.svg",
  "/images/badges/mods/mod-double-time.svg",
  "/images/badges/mods/mod-dual-stages.svg",
  "/images/badges/mods/mod-easy.svg",
  "/images/badges/mods/mod-eight-keys.svg",
  "/images/badges/mods/mod-fade-in.svg",
  "/images/badges/mods/mod-five-keys.svg",
  "/images/badges/mods/mod-flashlight.svg",
  "/images/badges/mods/mod-floating-fruits.svg",
  "/images/badges/mods/mod-four-keys.svg",
  "/images/badges/mods/mod-freeze-frame.svg",
  "/images/badges/mods/mod-grow.svg",
  "/images/badges/mods/mod-half-time.svg",
  "/images/badges/mods/mod-hard-rock.svg",
  "/images/badges/mods/mod-hidden.svg",
  "/images/badges/mods/mod-hold-off.svg",
  "/images/badges/mods/mod-icon-extender.svg",
  "/images/badges/mods/mod-invert.svg",
  "/images/badges/mods/mod-magnetised.svg",
  "/images/badges/mods/mod-mirror.svg",
  "/images/badges/mods/mod-moving-fast.svg",
  "/images/badges/mods/mod-muted.svg",
  "/images/badges/mods/mod-nightcore.svg",
  "/images/badges/mods/mod-nine-keys.svg",
  "/images/badges/mods/mod-no-fail.svg",
  "/images/badges/mods/mod-no-mod.svg",
  "/images/badges/mods/mod-no-release.svg",
  "/images/badges/mods/mod-no-scope.svg",
  "/images/badges/mods/mod-one-key.svg",
  "/images/badges/mods/mod-perfect.svg",
  "/images/badges/mods/mod-random.svg",
  "/images/badges/mods/mod-relax.svg",
  "/images/badges/mods/mod-repel.svg",
  "/images/badges/mods/mod-score-v2.svg",
  "/images/badges/mods/mod-seven-keys.svg",
  "/images/badges/mods/mod-simplified-rhythm.svg",
  "/images/badges/mods/mod-single-tap.svg",
  "/images/badges/mods/mod-six-keys.svg",
  "/images/badges/mods/mod-spin-in.svg",
  "/images/badges/mods/mod-spun-out.svg",
  "/images/badges/mods/mod-strict-tracking.svg",
  "/images/badges/mods/mod-sudden-death.svg",
  "/images/badges/mods/mod-swap.svg",
  "/images/badges/mods/mod-synesthesia.svg",
  "/images/badges/mods/mod-target-practice.svg",
  "/images/badges/mods/mod-ten-keys.svg",
  "/images/badges/mods/mod-three-keys.svg",
  "/images/badges/mods/mod-touch-device.svg",
  "/images/badges/mods/mod-traceable.svg",
  "/images/badges/mods/mod-transform.svg",
  "/images/badges/mods/mod-two-keys.svg",
  "/images/badges/mods/mod-wiggle.svg",
  "/images/badges/mods/mod-wind-down.svg",
  "/images/badges/mods/mod-wind-up.svg",
  // Page header icons
  "/images/icons/artists.svg",
  "/images/icons/beatmappacks.svg",
  "/images/icons/beatmapsets.svg",
  "/images/icons/changelog.svg",
  "/images/icons/chat.svg",
  "/images/icons/contests.svg",
  "/images/icons/forum.svg",
  "/images/icons/friends.svg",
  "/images/icons/help.svg",
  "/images/icons/home.svg",
  "/images/icons/news.svg",
  "/images/icons/notifications.svg",
  "/images/icons/profile.svg",
  "/images/icons/rankings.svg",
  "/images/icons/search.svg",
  "/images/icons/settings.svg",
  "/images/icons/store.svg",
  "/images/icons/supporter.svg",
  "/images/icons/tournaments.svg",
  // Note images
  "/images/notes/arrow-down-gray.png",
  "/images/notes/arrow-down-green.png",
  "/images/notes/arrow-left-gray.png",
  "/images/notes/arrow-left-pink.png",
  "/images/notes/arrow-right-gray.png",
  "/images/notes/arrow-right-green.png",
  "/images/notes/arrow-up-gray.png",
  "/images/notes/arrow-up-pink.png",
  "/images/notes/bar-blue.png",
  "/images/notes/bar-gray.png",
  "/images/notes/bar-red.png",
  "/images/notes/bar-yellow.png",
  "/images/notes/circle-blue-light.png",
  "/images/notes/circle-blue.png",
  "/images/notes/circle-gray.png",
  "/images/notes/circle-green.png",
  "/images/notes/circle-navy.png",
  "/images/notes/circle-pink-glow.png",
  "/images/notes/circle-pink.png",
  "/images/notes/circle-purple.png",
  "/images/notes/circle-violet.png",
  "/images/notes/circle-white.png",
  // Header backgrounds
  "/images/headers/chat.jpg",
  "/images/headers/generic.jpg",
  "/images/headers/news-show-default.jpg",
  "/images/headers/rankings.jpg",
  // Favicons
  "/favicon.svg",
  "/favicon.ico",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin static asset requests
  if (url.origin !== self.location.origin) return;
  if (
    !url.pathname.startsWith("/fonts/") &&
    !url.pathname.startsWith("/images/") &&
    !url.pathname.startsWith("/favicon")
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
