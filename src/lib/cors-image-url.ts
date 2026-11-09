/* WebGL can only read a picture from another origin that the server marked
   for CORS. The public CDN bucket answers every origin with `*`, but
   Cloudflare caches one copy per URL whatever the request's Origin was, so a
   plain <img> or a direct visit can leave a copy without the header in front
   of everyone. Textures load under their own URL, which only ever sees CORS
   requests, so its cached copy always carries the header. Local pictures
   (blob:, data:) pass through. */
export function corsImageUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}cors=1`;
}
