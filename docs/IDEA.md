# Idea

## Challenge
NASA Space Apps 2026: "Planet X and SPHEREx". Also competing for the local "Best Use of Azure" award.

## Pitch
Into The Unknown turns selected NASA SPHEREx observations into a shared-stretch
flipbook with Gaia context, helping people inspect possible motion and brightness
changes. Its Learn page guides observation in English, Spanish and Hindi.

**Confirmed project name:** Into The Unknown. **Registered team name:** LOGICA.
Both names were confirmed by the user on 2026-11-15. Registration of every member,
formal roles and the final submission remain human confirmations.

## Target user
Citizen scientists first. No login, no install, open a link and look at a patch of sky.

## What it does
Enter RA/Dec, see the SPHEREx time series of that patch as a flipbook to spot motion and variability.

## Scope

### MVP
- RA/Dec input and target picker with the 5 test objects
- Epoch flipbook (play/pause, speed, blink first vs last)
- FOV selector
- Shareable URL
- Metadata panel
- Per-epoch stacking with consistent asinh stretch
- Difference mode
- Golden snapshots of the 5 targets, so all 5 load with the API stopped

### Delivered extensions
- Gaia DR3 "should be here" overlay, with a "Gaia match / no Gaia match" label on the selected source
- Light curve panel
- Flag overlay
- Click-pixel spectrum

### Unshipped ideas (not submission claims)
- Brown dwarf color mode
- Auto-flag movers (field-wide candidate detection; the Tier 2 overlay only labels the selected source)
- "Report a candidate"

### Cut
- Known-asteroid matching
- Hosting our own sky tiles
- Freeform AI chat
- Durable Functions, Azure OpenAI captions

### Azure track (parallel, not an MVP gate item)
- Watcher Function: deployed daily metadata check and five pinned Live refresh requests; first successful metadata refresh is pending upstream IRSA recovery
- Forty-seven prepared catalog fields on public Blob; delivered images are distinct from validated science
- English/Spanish/Hindi Learn activities using fixed saved data, share links and PNG postcards
- Application Insights: latency, IRSA failures, cache hits
