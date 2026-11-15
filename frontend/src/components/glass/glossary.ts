/**
 * Built-in definitions for astronomical units, SPHEREx telemetry, and controls.
 * Definitions are derived from SPHEREx pipeline specifications and astronomy conventions.
 */
export const GLOSSARY: Record<string, string> = {
  // Flagged-pixel mask names (mean count per frame inside cutout, cleaned from this pass)
  // unsure: flag meanings derived from SPHEREx pipeline specifications
  TRANSIENT: "Cosmic ray strike or sudden single-frame brightness spike (cleaned from this pass).",
  SUR_ERROR: "Surface brightness fitting uncertainty or local background subtraction error.",
  DICHROIC: "Ghost optical reflection from the telescope beam-splitting dichroic filters.",
  NONFUNC: "Dead, disconnected, or non-functional detector pixel.",
  PERSIST: "Latent residual charge remaining on the detector from a bright star in an earlier frame.",
  CROSSTALK: "Electronic signal interference bleeding between adjacent readout channels.",
  COLD: "Low-sensitivity or uncalibrated cold detector pixel.",
  SNOWBALL: "Large energetic cosmic-ray shower creating a multi-pixel blooming circle.",

  // Additional SPHEREx detector quality flags (from Level 2 bitmasks)
  // unsure: meanings derived from SPHEREx spectral detector docs
  SOURCE: "Bright celestial source identified above local background threshold.",
  OVERFLOW: "Pixel full-well saturation or analog-to-digital converter limit reached.",
  NONLINEAR: "Detector response non-linearity near saturation limit.",
  FULLSAMPLE: "Full-sample detector readout mode without sample skipping.",
  HALO: "Diffraction or optical scattering halo surrounding a bright foreground star.",
  BLOOM: "Charge spillover across columns caused by detector saturation.",
  "Masked pixels": "Detector artifacts and cosmic rays cleaned from this pass (mean count per frame).",

  // Celestial coordinates and units
  RA: "Right Ascension: sky longitude measured eastward along the celestial equator (hours:minutes:seconds).",
  Dec: "Declination: sky latitude measured north (+) or south (-) from the celestial equator (degrees:arcmin:arcsec).",
  "RA/Dec": "Equatorial sky coordinates: Right Ascension (longitude) and Declination (latitude).",
  "MJy/sr": "Mega-Janskys per steradian: unit of surface brightness (radiation intensity per sky area).",
  uJy: "Micro-Janskys: unit of spectral flux density for point sources (1 µJy = 10⁻³² W/m²/Hz).",
  "µJy": "Micro-Janskys: unit of spectral flux density for point sources (1 µJy = 10⁻³² W/m²/Hz).",

  // Telescopes and instruments
  "Gaia G": "Optical magnitude from the ESA Gaia space telescope. Lower numbers mean brighter stars.",
  "(lit.)": "Published literature value from prior astronomical research, not verified in Gaia DR3.",
  Literature: "Published literature value from prior astronomical research, not verified in Gaia DR3.",
  Detectors: "SPHEREx carries 6 detector arrays (D1 to D6), each capturing a distinct infrared wavelength band.",
  Det: "SPHEREx detector array (D1 through D6) that captured this frame.",
  Release: "SPHEREx data archive releases and pipelines used to generate these stacked cutouts.",
  "Colours not matched": "Passes cover different infrared channels; brightness shifts may reflect wavelength coverage rather than real variability.",
  Colours: "Infrared bandpass matching across survey passes.",

  // Image controls
  "Asinh/Linear": "Brightness stretch: Asinh balances faint details and bright stars; Linear maps pixel values directly.",
  Asinh: "Inverse hyperbolic sine stretch: reveals faint details without blowing out bright cores.",
  Linear: "Direct linear transfer: maps detector pixel values directly to screen brightness.",
  "Smooth pixels": "Bilinear interpolation across detector pixels. Turn off to see the raw 6.15 arcsecond pixels.",
  Invert: "Negative color map: shows black stars on a white sky to make faint dipoles jump out.",
  "Field of view": "Angular width of the sky patch displayed in the eyepiece, measured in arcminutes (′).",
  "Proper motion": "Apparent motion of a star across the sky relative to distant background stars (arcseconds/year).",
  Parallax: "Annual apparent wobble of a star as Earth orbits the Sun; directly yields distance in light-years.",

  // Field guide glossary
  arcminute: "Unit of angular width on the sky equal to 1/60th of a degree (symbol ′). Full Moon is ~31′ across.",
  arcsecond: "Unit of angular width equal to 1/60th of an arcminute (symbol ″). SPHEREx pixels are 6.15″ wide.",
  mas: "Milliarcsecond: one thousandth of an arcsecond. Used for precision parallax and motion.",
  pass: "One complete six-month survey sweep of the whole sky by the SPHEREx satellite.",
  band: "One of SPHEREx's 6 spectral detector arrays (B1 to B6) covering 0.75 to 5.0 µm.",
  micron: "Micrometer (µm), one millionth of a metre. Standard wavelength unit for infrared light.",

  // Modes & second half preparations
  "Difference pair": "Dipole from subtracting two passes: silver where the star was, amber where it is now.",
};

export function getTermDefinition(term: string): string {
  if (GLOSSARY[term]) return GLOSSARY[term];
  const upper = term.toUpperCase().trim();
  if (GLOSSARY[upper]) return GLOSSARY[upper];
  const norm = term.toLowerCase().trim();
  for (const [k, v] of Object.entries(GLOSSARY)) {
    if (k.toLowerCase() === norm) return v;
  }
  // unsure: fallback for uncatalogued detector flags or parameters
  return `SPHEREx instrument or data parameter: ${term}`;
}
