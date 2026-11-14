// DEV ONLY. Serves the production catalog endpoint contract without a backend.
import type { Catalog } from "../types";

export const fixtureCatalog: Catalog = {
  version: "dev-2026-11-14",
  generated_at: "2026-11-14T18:00:00Z",
  source: { kind: "local", uri: "dev-fixture/catalog/targets.json" },
  objects: [
    {
      id: "barnard",
      name: "Barnard's Star",
      kind: "star",
      ra_deg: 269.45208,
      dec_deg: 4.69336,
      ref_epoch: 2000,
      parallax_mas: 546.9759,
      parallax_err_mas: null,
      distance_pc: null,
      pmra_mas_yr: -801.551,
      pmdec_mas_yr: 10362.394,
      preset_id: "barnard",
      provenance: { catalog: "Gaia DR3", ref: "https://measuredcosmos.com/stars/barnards-star" },
    },
    {
      id: "fixture-nearby-star",
      name: "Fixture Nearby Star",
      kind: "star",
      ra_deg: 42,
      dec_deg: -18,
      ref_epoch: 2016,
      parallax_mas: 125,
      parallax_err_mas: 0.5,
      distance_pc: null,
      pmra_mas_yr: 80,
      pmdec_mas_yr: -35,
      preset_id: null,
      provenance: { catalog: "Dev fixture", ref: "dev-fixture/catalog/targets.json" },
    },
  ],
};

/** Intercept only /api/catalog on the dev page and leave every other request unchanged. */
export function installCatalogFixture(): void {
  const networkFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(requestUrl, window.location.origin);
    if (url.pathname !== "/api/catalog") return networkFetch(input, init);

    const setName = url.searchParams.get("set") ?? "targets";
    if (setName !== "targets") {
      return Promise.resolve(new Response(
        JSON.stringify({ error: { code: "UNKNOWN_CATALOG_SET", message: `Catalog set '${setName}' is not available.` } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ));
    }
    return Promise.resolve(new Response(JSON.stringify(fixtureCatalog), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  };
}
