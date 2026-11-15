// Fixed-origin HTTPS gateway; application and data processing remain on Azure.
export const ORIGIN = "https://ca-planetx-api.politesand-6f83d8b5.westus.azurecontainerapps.io";
const PUBLIC_HEADERS = new Set([
  "accept", "accept-language", "content-type", "if-none-match", "if-modified-since", "range",
]);

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    if (incoming.protocol === "http:") {
      incoming.protocol = "https:";
      return Response.redirect(incoming.href, 308);
    }
    const target = new URL(incoming);
    target.protocol = "https:";
    target.host = new URL(ORIGIN).host;
    const forwarded = new Request(target, request);
    // Never forward Sites/session cookies, authorization or platform headers.
    for (const name of [...forwarded.headers.keys()]) {
      if (!PUBLIC_HEADERS.has(name.toLowerCase())) forwarded.headers.delete(name);
    }
    try {
      const upstream = await fetch(forwarded, { redirect: "manual" });
      const response = new Response(upstream.body, upstream);
      response.headers.delete("set-cookie");
      const location = response.headers.get("location");
      if (location) {
        const destination = new URL(location, target);
        if (destination.origin === ORIGIN) {
          destination.host = incoming.host;
          response.headers.set("location", destination.href);
        }
      }
      return response;
    } catch {
      return Response.json({ error: {
        code: "GATEWAY_UNAVAILABLE", message: "The Azure app is temporarily unreachable. Please try again.",
      } }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  },
};
