/* Private servers a player can link from their profile. The
   keys and the domains each link must be on are the backend's
   (live-backend features/server-links.ts), which is what enforces them; this
   side only names them and gives the picker something to show. Logos come
   from osu-server-list.com. */

export interface PrivateServer {
  key: string;
  name: string;
  domains: readonly string[];
}

export const PRIVATE_SERVERS: readonly PrivateServer[] = [
  { key: "akatsuki", name: "Akatsuki", domains: ["akatsuki.gg"] },
  { key: "mamestagram", name: "Mamestagram", domains: ["mamesosu.net"] },
  { key: "gatari", name: "Gatari", domains: ["gatari.pw"] },
  { key: "ezppfarm", name: "EZPPFarm", domains: ["ez-pp.farm"] },
  { key: "ppysb", name: "ppy.sb", domains: ["ppy.sb"] },
  { key: "realistikosu", name: "RealistikOsu", domains: ["ussr.pl"] },
  { key: "ripple", name: "Ripple", domains: ["ripple.moe"] },
  { key: "titanic", name: "osu!Titanic", domains: ["titanic.sh"] },
  { key: "datenshi", name: "Datenshi", domains: ["datenshi.pw"] },
  { key: "sunrise", name: "Sunrise", domains: ["sunrize.uk"] },
  { key: "torii", name: "Torii", domains: ["shikkesora.com"] },
  { key: "redstar", name: "osu!Redstar", domains: ["redstar.moe"] },
  { key: "nolimits", name: "NoLimits", domains: ["osunolimits.dev"] },
  { key: "mellowosu", name: "mellowosu", domains: ["mellowosu.ru"] },
  { key: "nekosu", name: "Nekosu", domains: ["neko.org.es"] },
  { key: "seventwentyseven", name: "SevenTwentySeven", domains: ["seventwentyseven.xyz"] },
];

export function privateServer(key: string): PrivateServer | undefined {
  return PRIVATE_SERVERS.find((server) => server.key === key);
}

export function privateServerLogo(key: string): string {
  return `/images/private-servers/${key}.png`;
}

/** The server a pasted profile link is on, read from its domain. The backend has the final say. */
export function detectPrivateServer(input: string): PrivateServer | undefined {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return undefined;
  }
  if (url.pathname.replace(/\/+$/, "").length === 0) return undefined;
  const host = url.hostname.toLowerCase();
  return PRIVATE_SERVERS.find((server) => server.domains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
}
