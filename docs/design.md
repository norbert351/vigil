# VIGIL — Design System (locked 2026-09-16)

**Tone sentence:** *"Executive night-watch terminal meets premium SaaS — deep calm navy,
one precise light-blue accent, white type on real photography. The agent that trades
the hours humans sleep."*

**Audience:** hackathon judges + retail/institutional traders who hold tokenized US
stocks + crypto and want a defensible overnight agent.

## Palette (per explicit brief: navy / light blue bg + white)

| Token | Hex | Use |
|---|---|---|
| `--bg-0` | `#070F1D` | page base (deepest navy) |
| `--bg-1` | `#0B1B33` | panel / section |
| `--bg-2` | `#12284A` | raised card, hover |
| `--bg-grad` | `linear-gradient(160deg,#0B1B33, #16325C 55%, #1D4E89)` | hero/section wash (navy→light blue) |
| `--brand` | `#4FA3FF` | primary light blue (buttons, links, accents) |
| `--brand-2` | `#6FD3FF` | cyan highlight (live pulses, glows) |
| `--white` | `#FFFFFF` | headlines, primary type |
| `--txt` | `#D7E4F5` | body text |
| `--mut` | `#8FA9CB` | muted / labels |
| `--line` | `rgba(160,190,230,.16)` | hairline borders |
| `--up` | `#3DD68C` | positive P&L |
| `--down` | `#FF6B6B` | negative P&L |
| `--glass` | `rgba(255,255,255,.06)` | glass chip surfaces |

Contrast: white on navy = AA+ everywhere; muted ≥ AA on panels.

## Typography (fresh pair, Fontshare CDN — zero-dep static pages)

- **Display:** Cabinet Grotesk (600/700) — H1/H2, hero and section titles.
- **Body:** General Sans (400/500/600) — paragraphs, nav, buttons, cards.
- **Mono:** JetBrains Mono (400/600) — prices, numbers, sentinels, log readouts.
- CDN: Fontshare CSS API + Google Fonts css2 (plain `<link>`, no build step).

## Composition (this project's variation picks)

- **Theme:** dark navy (per explicit brief).
- **Hero architecture:** FULL-BLEED Pexels night-city/trading image, scaled + navy
  gradient scrim (darkest at bottom), headline + sub + CTAs ON TOP of the image
  (explicit request), floating live-status chip, scroll cue. Warm brand → follows
  "text on top of image" literally.
- **Section system:** split rows (image ⇄ copy) + glass stat strip + 3-step "how it
  works" + sponsor-tech band + CTA finale.
- **Motion:** `cubic-bezier(.16,1,.3,1)`; load-in stagger (fade+rise), IntersectionObserver
  scroll-reveal (with visible-by-default fallback), hover lift/`translateY`,
  ken-burns slow zoom on hero image, live pulse on status dots, marquee ticker of the
  universe symbols.
- **Icons:** inline SVG (stroke 1.5), no icon lib (zero-dep).
- **Header:** slim brand-left nav (home / product / how it works / log), **Connect**
  pill right → product page. Mobile: hamburger ≤900px with working toggle.
- **Product page (`/app`):** full dashboard — KPI grid, allocation bars, holdings
  table, signed decision log, live SSE agent stream, kill-switch, "← Home" link.
- **Root `/` = marketing landing only; live product data lives ONLY on `/app`.**

## Connect vs Login (decision)

VIGIL has no user accounts — it is an autonomous agent bound to a Bitget API key.
The correct primary control is **"Connect"** (connect to the live agent / view the
running book), not login. Header + hero CTA = `Connect · live agent →` to `/app`.

## Imagery (Pexels, downloaded locally, never hotlinked)

- `hero-night-city.jpg` — city skyline at night (financial district feel), DARK
  enough for white text under scrim (brightness < 100).
- `desk-night.jpg` — trading desk / screens with charts at night.
- `ticker-skyline.jpg` — macro/skyline abstract for the how-it-works band.
- All served from `/images/*` with `Cache-Control: public, max-age=3600`.