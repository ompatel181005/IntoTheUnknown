# SKELETON from the hackathon plan: not yet run against live IRSA or Azure.
# Destination: backend/app/processing/gaia.py. Copy it there when you start that slice and delete this file in the same PR.

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord, Distance, get_body_barycentric
from astropy.time import Time

GAIA_EPOCH = Time(2016.0, format="jyear", scale="tcb")

def predict_radec(ra, dec, pmra, pmdec, plx, rv, t: Time) -> tuple[float, float]:
    """Astrometric position seen from Earth at t: space motion + parallax, NO aberration (matches SPHEREx WCS)."""
    if not (plx and plx > 0):                                       # pm-only fallback
        c = SkyCoord(ra * u.deg, dec * u.deg, pm_ra_cosdec=(pmra or 0) * u.mas / u.yr,
                     pm_dec=(pmdec or 0) * u.mas / u.yr, obstime=GAIA_EPOCH, frame="icrs")
        s = c.apply_space_motion(new_obstime=t)
        return s.ra.deg, s.dec.deg
    c = SkyCoord(ra * u.deg, dec * u.deg, distance=Distance(parallax=plx * u.mas),
                 pm_ra_cosdec=pmra * u.mas / u.yr, pm_dec=pmdec * u.mas / u.yr,
                 radial_velocity=(0 if rv is None or np.isnan(rv) else rv) * u.km / u.s,
                 obstime=GAIA_EPOCH, frame="icrs")
    bary = c.apply_space_motion(new_obstime=t).cartesian.without_differentials()
    geo = SkyCoord(bary - get_body_barycentric("earth", t), frame="icrs")   # parallax via vector subtraction
    return geo.ra.deg, geo.dec.deg
