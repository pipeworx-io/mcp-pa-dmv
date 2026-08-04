# @pipeworx/pa-dmv

Pennsylvania DMV MCP — registered vehicles and electric-vehicle adoption by county and by
ZIP code, from PennDOT Driver & Vehicle Services.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `pa_dmv_ev_adoption(county?, year?, quarter?, limit?)` — battery-electric, plug-in
  hybrid, fuel-cell and conventional hybrid registrations for each of Pennsylvania's 67
  counties in one quarter, with plug-in share and a genuine statewide total. Answers "how
  many EVs are registered in Pennsylvania", "EV share in Allegheny County", "which
  Pennsylvania county has the most electric vehicles".
- `pa_dmv_vehicle_registrations(county?, year?, quarter?, limit?)` — the whole registered
  fleet of every fuel type by county, with a statewide total and each county's share.
  Rides on the same layer, which carries `TOTAL_REG` alongside the EV columns.
- `pa_dmv_ev_adoption_by_zip(zip?, year?, quarter?, limit?)` — the same drivetrain
  breakdown for ~1,830 Pennsylvania ZIP codes. Answers "how many EVs are registered in ZIP
  19103", "which Pennsylvania ZIP code has the most electric vehicles".

## Auth

Keyless.

## Data sources

- <https://gis.penndot.pa.gov/gis/rest/services/opendata/evregistrationscounty/MapServer/0>
  — 67 counties × registration years 2023–2026. Attributes: `COUNTY_NAME`,
  `COUNTY_NUMBER`, `FIPS_COUNTY_CODE`, `DISTRICT_NO`, `PLANNING_PARTNER`,
  `REGISTRATION_YEAR`, then per-quarter `HEV_Q*`, `PHEV_Q*`, `BEV_Q*`, `FUEL_CELL_Q*`,
  `TOTAL_EV_Q*`, `TOTAL_REG_Q*`, `PCT_EV_Q*`.
- <https://gis.penndot.pa.gov/gis/rest/services/opendata/evregistrationszip/MapServer/0>
  — 7,328 records total, ~1,832 per registration year. Same quarter columns keyed on `ZIP`.

Both layers have `maxRecordCount` 2000, so a full year fits in a single request and no
paging is needed. Latest published quarter as of 2026-07-29 is **2026 Q2**.

## Gotcha: quarters are COLUMNS, not rows

Each feature is one county (or ZIP) for one `REGISTRATION_YEAR`, carrying all four
quarters side by side as separate column groups. Quarters PennDOT has yet to file are
present as `null` columns. There is no row to filter on and no date field to sort by, so
"the latest data" means walking `Q4 → Q1` looking for a quarter that actually carries
values.

`pickQuarter()` does that walk **once for the whole result set**, not per row. Picking a
quarter per row looks harmless on a single-county lookup and is a correctness bug on a
ranking: you end up comparing one county's Q2 against another's Q1 and summing the mix
into a "statewide total". A quarter is accepted only if at least half as many rows carry
it as carry the best-covered quarter, so one early-reporting straggler cannot drag the
whole answer forward.

## Gotcha: hybrids sit outside TOTAL_EV

PennDOT's `TOTAL_EV = BEV + PHEV + FUEL_CELL`. Conventional hybrids (`HEV`) are reported
**separately** and are deliberately excluded — a Prius appears in `hybrid_gasoline` and
never in `plug_in_vehicles`. Verified across all 67 counties × both 2026 quarters: zero
mismatches between `TOTAL_EV` and `BEV + PHEV + FUEL_CELL`.

## Gotcha: the ZIP layer's 2026 Q1 columns are wrong upstream

In the **ZIP** layer only, and in the **2026 Q1** column group only, PennDOT's own derived
columns are broken two ways:

- `TOTAL_EV_Q1` folds conventional hybrids in. ZIP 19103 publishes `TOTAL_EV_Q1` 1291
  against `BEV_Q1` 314 + `PHEV_Q1` 136 + `HEV_Q1` 841 = 1291.
- `PCT_EV_Q1` is written as a **fraction** of that inflated number rather than a percent.
  ZIP 19103 publishes 0.14 where the plug-in share is 4.85%.

Every other year, quarter and layer is internally consistent. So this pack **computes**
`plug_in_vehicles` and `ev_share_pct` from the component columns everywhere rather than
reading `TOTAL_EV` / `PCT_EV` — which reproduces PennDOT's published values exactly
wherever those are sound (Montgomery County 2026 Q1 → 22,606 and 2.87, matching), and
quietly repairs them where they are not.

## Gotcha: the ZIP file undercounts the state by ~0.5%

Summing every ZIP code gives 12,039,085 registered vehicles for 2026 Q2 against the county
layer's 12,098,320 — a few registrations carry no usable ZIP code. `pa_dmv_ev_adoption`
(county layer) is the authoritative statewide number; the ZIP tool labels its own sums
`zip_file_total_vehicles` rather than claiming a state total.

## Verified figures (checked 2026-07-29)

| Query | Result |
|---|---|
| `pa_dmv_ev_adoption{county:"Montgomery", year:"2026", quarter:"Q1"}` | BEV 16,243 · PHEV 6,363 · plug-in 22,606 · HEV 45,763 · total 788,762 · share 2.87% |
| `pa_dmv_ev_adoption{county:"Allegheny", year:"2026"}` (Q2) | plug-in 19,350 · total 965,589 |
| `pa_dmv_ev_adoption{}` (2026 Q2) | statewide 171,670 plug-in of 12,098,320 registered, 1.42% |
| `pa_dmv_ev_adoption_by_zip{zip:"19103", year:"2026"}` (Q2) | BEV 337 · PHEV 131 · plug-in 468 · total 9,322 · share 5.02% |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "pa-dmv": {
      "url": "https://gateway.pipeworx.io/pa-dmv/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Pa Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
