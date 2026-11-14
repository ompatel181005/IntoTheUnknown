# SKELETON from the hackathon plan: not yet run against live IRSA or Azure.
# Destination: functions/function_app.py. Copy it there when you start that slice and delete this file in the same PR.

import datetime as dt, json, logging, os, re
import azure.functions as func
import requests
from astroquery.ipac.irsa import Irsa
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobClient, ContentSettings

app = func.FunctionApp()
COLL_RE = re.compile(r"^spherex_(dr|qr)(\d+)(_deep)?$")

def _catalog_blob() -> BlobClient:
    return BlobClient(os.environ["STORAGE_ACCOUNT_URL"], "frames", "meta/catalog.json",
                      credential=DefaultAzureCredential())

def check_catalog() -> dict:
    names = sorted(n for n in map(str, Irsa.list_collections(servicetype="SIA", filter="spherex")["collection"])
                   if COLL_RE.match(n))
    latest = float(Irsa.query_tap("SELECT MAX(time_bounds_lower) AS t FROM spherex.plane").to_table()["t"][0])
    blob = _catalog_blob()
    try:
        old = json.loads(blob.download_blob().readall())
    except Exception:
        old = {}
    changed = names != old.get("collections") or latest > old.get("latest_frame_mjd", 0)
    new = {"collections": names, "latest_frame_mjd": latest,
           "checked_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
           "catalog_version": f"c{dt.date.today():%Y%m%d}-{len(names)}-{int(latest)}" if changed
                              else old.get("catalog_version")}
    blob.upload_blob(json.dumps(new), overwrite=True,               # also feeds the "data as of" badge
                     content_settings=ContentSettings(content_type="application/json", cache_control="public, max-age=60"))
    if changed:
        r = requests.post(f"{os.environ['API_BASE']}/internal/refresh", timeout=30,
                          headers={"X-Refresh-Key": os.environ["REFRESH_KEY"]},
                          json={"reason": "catalog_change", "catalog_version": new["catalog_version"]})
        logging.info("refresh → %s %s", r.status_code, r.text[:200])
    return {**new, "changed": changed}

@app.timer_trigger(schedule="0 0 6 * * *", arg_name="timer", run_on_startup=False, use_monitor=False)  # 06:00 UTC
def new_data_watcher(timer: func.TimerRequest) -> None:
    logging.info("watcher: %s", check_catalog())

@app.route(route="run-now", methods=["POST"], auth_level=func.AuthLevel.FUNCTION)                     # demo button
def run_now(req: func.HttpRequest) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(check_catalog()), mimetype="application/json")
