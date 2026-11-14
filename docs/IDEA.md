# Idea

## Challenge
NASA Space Apps 2026: "Planet X and SPHEREx". Also competing for the local "Best Use of Azure" award.

## Pitch
Type any spot on the sky and watch it move in 102 infrared colours. Wanderer blinks NASA's newest all-sky survey and predicts where every Gaia star should be, so a mover Gaia can't explain stands out.

Working name: Wanderer (`docs/PLAN.md` §3). TODO(team): confirm the name.

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

### Tier 2
- Gaia DR3 "should be here" overlay (lead differentiator, built first after the MVP gate), with a "Gaia match / no Gaia match" label on the selected source
- Light curve panel
- Flag overlay
- Click-pixel spectrum

### Tier 3
- Brown dwarf color mode
- Auto-flag movers (field-wide candidate detection; the Tier 2 overlay only labels the selected source)
- "Report a candidate"

### Cut
- Known-asteroid matching
- Hosting our own sky tiles
- Freeform AI chat
- Durable Functions, Azure OpenAI captions

### Azure track (parallel, not an MVP gate item)
- Watcher Function: daily catalog check, re-render on new data
- Application Insights: latency, IRSA failures, cache hits
