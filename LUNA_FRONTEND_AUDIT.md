# Herkos frontend audit — implementation brief for Luna

**Status:** Submission-blocking remediation required  
**Audience:** Hackathon judges, lending protocol teams, and technically curious FXRP holders  
**Scope:** `demo/index.html`, `demo/app.js`, `demo/style.css`, and the public static-site flow  
**Audit posture:** Treat every unexplained number, stale fallback, internal phase name, raw error, and non-functional control as something a hostile judge will challenge.

This is not a request for another visual reskin. The current page is an engineering notebook dressed as a landing page. The remediation must turn it into a concise product demonstration while preserving the project’s truthful boundaries.

## Current verification evidence

- Desktop browser at 1280×720: page renders, but the public flow is 9,447 px tall and contains 18,687 visible characters before any technical documents are opened.
- Mobile browser at 390×844: document width is 455 px, producing 65 px of horizontal overflow.
- Live runtime: the FDC panel displays the raw error `return blob too short at word 44393.6875`.
- Public fork control: clicking **Connect** waits and then displays `Failed to fetch` because it probes the visitor’s `localhost:8545`.
- Oracle comparison: the page compared the live incumbent at approximately `$1.017068` with a recorded Herkos value of `$1.039342`, then claimed “They agree to 219.00 bips.” These values are from different times and must never be compared.
- Navigation contains 7 links, all same-page anchors. There is no real source, technical paper, explorer, submission, or demo-video link.
- Only one action button exists, and it is the localhost fork control that fails for ordinary visitors.

## Non-negotiable product rules

1. The public site must explain Herkos in 10 seconds, prove the result in 30 seconds, and offer technical evidence within 90 seconds.
2. Never compare values captured at different blocks or timestamps.
3. Never label recorded data as live. Never hide the forked nature of a result.
4. Never expose raw RPC, ABI-decoding, fetch, or localhost errors to a visitor.
5. No `Phase 0`–`Phase 5`, test function names, result filenames, Anvil instructions, localhost controls, or internal handoff language in the default public flow.
6. No placeholder ellipses, empty tables, fake progress, decorative charts without a defined denominator, or controls that do not work on the hosted site.
7. Every visible CTA must lead somewhere useful. If the final URL is not configured, omit the CTA rather than use `#`, a fake URL, or a dead button.
8. Keep the site light. Do not add a dark section, purple gradient, glass cards, glowing borders, floating blobs, fake terminal, or generic crypto artwork.
9. Preserve the honest boundaries: mainnet reads are live; the market integration is a recorded mainnet-fork demonstration; the FDC proof is replayed rather than freshly originated.
10. Do not remove technical evidence from the repository. Move it to `README.md`, `Writeup1.md`, or one collapsed “Technical evidence” disclosure linked from the public page.

## P0 — submission blockers

### P0.1 Stop comparing live and recorded oracle prices

**Evidence**

- `demo/app.js:619-655` always renders the recorded Herkos snapshot, reads the incumbent live, and passes both to `renderDelta()`.
- `demo/index.html:166-169` explicitly describes one value as live and the other as recorded.
- Browser result: live `$1.017068` versus recorded `$1.039342`, presented as “They agree to 219.00 bips.”

**Required change**

- The primary comparison must use one coherent snapshot: both incumbent and Herkos from the pinned fork result, with one visible “Mainnet fork snapshot” timestamp/block label.
- A separate live market-price card may exist, but it must not be numerically compared with the recorded Herkos result.
- Remove the sentence “They agree …” unless both values share the same block and the UI can prove that provenance.
- Replace `recorded` with a human label such as `Mainnet fork snapshot · block 67,013,823`.

**Acceptance**

- No function can compute a delta across mismatched timestamps.
- Every comparison displays a shared block or “as of” time.
- A stale snapshot remains useful without pretending to be current.

### P0.2 Remove the broken public FDC decoder state

**Evidence**

- `demo/app.js:550-601` decodes old transaction calldata in the browser and writes raw exceptions into the page.
- Current browser result: `return blob too short at word 44393.6875`.
- `demo/index.html:145-161` promises a working live proof before the decoder succeeds.

**Required change**

- Fix and re-verify the decoder against the current transaction shape, or remove the live decoder from the public page.
- Preferred public presentation: a compact “Proof verification” card with verified/not verified, proof source, block, and a real explorer link. Put raw tuple fields in a technical disclosure.
- If verification is unavailable, show a composed state: “Live proof check is temporarily unavailable” plus a real retry action. Do not show exception text.
- Do not retain a green `live` badge when the panel failed.

**Acceptance**

- No `.fail` element contains implementation errors such as `return blob`, `HTTP`, `Failed to fetch`, stack details, selectors, or word offsets.
- The visible claim reflects the actual verification state.

### P0.3 Delete the localhost fork control from the hosted product

**Evidence**

- `demo/index.html:171-176` exposes Fork RPC, Herkos address, and **Connect**.
- `demo/app.js:658-717` sends requests to a visitor-supplied RPC, defaulting to `http://localhost:8545`.
- Browser result after clicking: `Failed to fetch`.

**Required change**

- Remove the entire fork bar, both inputs, the Connect button, and fork status from the public build.
- Keep local-fork instructions in `README.md` and `setup1.md`.
- The public demo must render the coherent recorded stress result without requiring developer infrastructure.

**Acceptance**

- Public DOM contains no `localhost`, `Fork RPC`, `Herkos address`, or `Connect` control.
- Hosted experience is complete without Foundry, Anvil, a wallet, or local services.

### P0.4 Remove internal phases and test history from the public UI

**Evidence**

- `demo/index.html:374-471` publishes the full Phase 0–5 command table, result filenames, ordering dependencies, fork clock rewinds, and troubleshooting notes.
- `demo/index.html:89-91` exposes a test function name in explanatory copy.
- `demo/index.html:335-339` and `demo/app.js:636-644` expose “Phase 4” as product language.
- `demo/app.js:738-744` reads the Phase 5 check count into the UI.

**Required change**

- Delete the entire “Reproduce every number” section from the default public page.
- Replace it with a compact final section: “Verify the work” with real links to source, technical writeup, contract/test suite, and the hackathon submission.
- Move all commands, phase dependencies, generated filenames, and venue caveats to repository documentation.
- Remove every public occurrence of `Phase`, `phase0-results`, `phase1-results`, `phase2-results`, `phase3-results`, `phase4-results`, `phase5-results`, `test_`, Anvil, and localhost.

**Acceptance**

- `rg -n -i "phase[ 0-9-]|phase[0-9]-results|test_|anvil|localhost" demo/` returns no user-facing copy. Code comments may remain only when they do not ship into visible content.

## P1 — rebuild the public story

### P1.1 Replace the engineering-notebook information architecture

**Evidence**

- `demo/index.html:34-59` makes internal execution venues the first section.
- `demo/index.html:107-161` places raw escrow objects and proof internals before the product outcome.
- `demo/index.html:228-264` devotes a full section to gas loops.
- `demo/index.html:268-370` lists 12 weaknesses in the main narrative.
- The page reaches the actual price/borrow-capacity result only after extensive infrastructure detail.

**Required public flow**

1. **Hero:** what Herkos does, who it protects, and one concrete outcome.
2. **Risk snapshot:** one current data story with freshness and sources.
3. **Stress result:** coherent pinned-fork comparison showing price/haircut/borrow-capacity change.
4. **How it works:** 3 plain-language steps—measure exits, compute haircut, serve Compound interface.
5. **Trust and provenance:** Flare, XRPL, FDC, and contract evidence in concise cards.
6. **Scope and limitations:** 3–4 honest constraints, not a 12-item postmortem.
7. **Real links:** source, writeup, tests, explorer/submission/demo video as available.

**Target**

- Default page body under approximately 1,200 words.
- Core argument visible without opening a disclosure.
- Raw tables and engineering detail available only after an explicit “Technical evidence” action.

### P1.2 Replace the templated hero with product proof

**Evidence**

- `demo/index.html:20-30` uses the familiar eyebrow + giant serif slogan + two anchor CTAs + trust microcopy pattern.
- `demo/style.css:21-31` creates an oversized 7.5rem hero with decorative concentric circles and a 9-character headline width.
- On mobile the hero consumes nearly the entire first viewport before showing any evidence.

**Required change**

- Keep the strongest phrase if desired, but reduce headline dominance and place a real product snapshot in the first viewport.
- Replace `Flare / FXRP research instrument` with a direct category such as `Exit-capacity oracle for FXRP lending markets`.
- Remove decorative rings unless they encode data.
- Remove “no backend / no wallet” from the hero. It is implementation trivia, not the value proposition.
- Do not add decorative crypto imagery. Use the actual measured risk snapshot as the visual anchor.

### P1.3 Replace the ambiguous bar chart

**Evidence**

- `demo/app.js:409-419` calculates bar widths against lending collateral but displays ratios against the redemption queue.
- A bar labelled `8.84×` currently occupies `69.60%`; another labelled `12.70×` occupies `100%`. The visual and label use different denominators.
- The chart mixes FXRP and XRP without a plain-language explanation.

**Required change**

- Use one denominator per visual and state it in the title/legend.
- Preferred decision visual: **Measured immediate exit capacity versus FXRP lending exposure**, with both values from the same block/time.
- Put queue, DEX, and liquid Core Vault contributions in a sourced breakdown below it.
- Show `as of` time, block, source, and whether the value is live or a snapshot.
- If the chart cannot remain truthful and understandable in one sentence, replace it with 2 large numbers and a ratio.

### P1.4 Turn technical data into consumer language

**Evidence**

- `demo/index.html:71-103`, `126-161`, `196-224`, and `232-264` expose ABI names, pool addresses, proof tuple language, governance constants, and gas-loop architecture in the main flow.
- `demo/app.js:421-454`, `478-538`, and `586-599` render source-level terminology directly into visitor-facing copy.

**Required change**

- Primary labels should answer: “What can exit now?”, “How much is exposed?”, “What price does Herkos return?”, and “What changes under stress?”
- Move contract method names, addresses, proof fields, pool rows, and exact gas mechanics into technical disclosures.
- Keep numbers inspectable, but lead with interpretation and consequence.
- Add tooltips or inline definitions for `haircut`, `exit capacity`, `reference size`, and `borrow capacity`.

### P1.5 Make limitations concise without hiding them

**Evidence**

- `demo/index.html:268-370` is a 12-item internal defense memo written directly to a hypothetical judge.
- Copy such as “say that,” “before a judge asks,” “not a weak demo,” and “the exact distance to adoption” sounds like private coaching notes.

**Required change**

- Replace with “Scope and limitations” containing no more than 4 concise points:
  - Forked mainnet integration, not live protocol adoption.
  - Replayed finalized FDC proof, not a newly originated mainnet proof.
  - Throughput is observed demand, not a guaranteed capacity ceiling.
  - Refreshes cost gas and production needs an incentive/cadence policy.
- Link to the full writeup for the rest.
- Remove all coaching language: `judge`, `say this`, `say that`, `not a weak demo`, `before someone asks`.

### P1.6 Replace ghost CTAs with real destinations

**Evidence**

- `demo/index.html:15-25` has 7 same-page anchor links across navigation and hero.
- No link leaves the page for source, technical documentation, contract evidence, submission, or demo media.

**Required change**

- Keep one primary anchor: `View risk snapshot`.
- Add only real external actions that are configured: `View source`, `Read technical writeup`, `Watch demo`, `Open submission`, `Verify contract`.
- Remove duplicate `View the measurement` / `Explore live data` CTAs.
- Do not render an external CTA until its URL exists.

### P1.7 Design complete loading, unavailable, and empty states

**Evidence**

- `demo/index.html:43-53`, `68-76`, `99`, `116-120`, `140`, `150`, `181-201` use bare `…` or “reading…” placeholders.
- `demo/app.js:491-495`, `600-601`, `632-635`, and `748-751` display low-level failures or leave partial sections.
- Async status regions do not use `aria-live`.

**Required change**

- Use small skeleton shapes for initial loads, then replace them with complete states.
- Add one unified source-status component with `aria-live="polite"`.
- On source failure, retain the last verified snapshot only if its timestamp is shown; otherwise hide the metric and say it is unavailable.
- Provide a real `Retry live data` button when retry is possible.
- Never leave empty rows, `—` as the only price, or a permanent spinner.

## P1 — responsive and accessibility defects

### P1.8 Eliminate mobile horizontal overflow

**Evidence**

- Browser at 390 px: document width 455 px.
- `demo/index.html:71-78` signal table is not inside `.scroll` and expands the document.
- `demo/style.css:35` gives tables a desktop presentation without a mobile strategy.
- Raw pool, escrow, ladder, and reproduction tables are wider than the viewport and depend on horizontal scrolling.

**Required change**

- Convert the primary signal table into responsive metric rows/cards below 700 px.
- Keep horizontal scrolling only for explicitly technical tables, with a visible “Scroll horizontally” affordance and contained overflow.
- Add `max-width: 100%`, `min-width: 0`, and word-breaking where needed.

**Acceptance**

- At 390×844, `document.documentElement.scrollWidth === window.innerWidth`.
- No content, focus ring, or CTA is clipped.

### P1.9 Fix baseline interface-guideline failures

**Evidence**

- `demo/index.html:11-480` has no skip link and no `<main>` landmark.
- Section anchors lack `scroll-margin-top`.
- `demo/style.css:38` uses `:focus` rather than `:focus-visible`.
- `demo/style.css:31` and `37-38` animate without a `prefers-reduced-motion` override.
- Async states and errors lack `aria-live`.
- Existing form controls lack `name`, `autocomplete`, and URL-specific input types; these controls should be removed from public UI anyway.
- Date rendering at `demo/app.js:527-528` and `705` uses hardcoded ISO formatting rather than locale-aware `Intl.DateTimeFormat`.

**Required change**

- Add skip navigation, `<main id="main">`, semantic sections, and `scroll-margin-top`.
- Use `:focus-visible` and keep strong keyboard focus.
- Honor `prefers-reduced-motion`.
- Add `aria-live="polite"` to asynchronous status and retry regions.
- Use `Intl.NumberFormat` and `Intl.DateTimeFormat` for visitor-facing values.
- Add `text-wrap: balance` to display headings and `text-wrap: pretty` to body copy.

## P2 — submission polish

### P2.1 Establish a real brand system

- The single-letter `H` mark reads as a placeholder. Replace it with a simple intentional Herkos wordmark/monogram or use the clean wordmark alone.
- Reduce the current mix of Georgia, Trebuchet, and monospace. Use one display family, one UI family, and monospace only for identifiers/numbers.
- Preserve the white/off-white palette and restrained teal accent.
- Add a real favicon and a social-preview image.

### P2.2 Add submission metadata and evidence links

- Add Open Graph and Twitter metadata, canonical URL, favicon, and preview image.
- Add a concise footer with real source, writeup, Flare bounty, and submission links.
- Add `rel="noopener noreferrer"` to external new-tab links.
- Do not invent URLs. Configure them centrally and omit missing actions.

### P2.3 Remove copy that sounds generated or defensive

Delete or rewrite phrases including:

- “Three of them, and keeping them straight…”
- “The drill-down below is the honest version…”
- “State the boundary before a judge asks.”
- “That is the credibility, not a weak demo.”
- “Read that table precisely.”
- “Collapsing it breaks the product claim.”
- “Stated here so a judge does not have to surface them.”
- “worth knowing before they surprise you”

Use direct product language. Explain what the number means and what action it supports.

## Required component/state contract

Luna should leave the public page with these explicit states:

| Surface | Loading | Success | Unavailable |
|---|---|---|---|
| Live risk snapshot | Skeleton metrics | Value + block/time + source | Last verified snapshot with age, or no value + retry |
| Fork stress result | No loading required | Coherent recorded snapshot with shared block | Hide section if snapshot file is missing |
| Proof verification | Neutral “Checking proof…” | Verified status + source/explorer link | “Live proof check unavailable” + retry; no raw exception |
| External links | Not rendered until configured | Real destination | Omit entirely |

## Final public-page acceptance checklist

- [ ] No live-versus-recorded numerical comparison.
- [ ] No visible `Phase 0`–`Phase 5`, test names, result filenames, localhost, Anvil, or internal run instructions.
- [ ] No raw exception, RPC, ABI, HTTP, fetch, selector, or decoding error.
- [ ] No dead or duplicate CTA; every rendered CTA has a real destination or working same-page target.
- [ ] No input asks a judge to provide RPC or contract details.
- [ ] No placeholder ellipsis or empty table remains after initialization settles.
- [ ] No horizontal overflow at 390, 768, 1280, and 1440 px widths.
- [ ] Main product outcome is visible in the first desktop viewport and by the second mobile viewport.
- [ ] Every live value displays source and freshness.
- [ ] Every snapshot value displays shared block/time and is labelled as a snapshot.
- [ ] The page remains truthful when Flare RPC, XRPL, or proof verification is unavailable.
- [ ] Source, writeup, and submission links are real and verified before rendering.
- [ ] Keyboard navigation, focus-visible, skip link, semantic landmarks, and reduced motion pass.
- [ ] `forge test -vv` still passes.
- [ ] `npm run phase5` is updated to validate the new public contract rather than requiring internal phase copy to remain visible.
- [ ] Browser pass performed at desktop and mobile after implementation, including source failure simulation.

## Implementation order

1. Fix data integrity: coherent snapshots and FDC failure.
2. Remove public localhost/fork controls and Phase 0–5 content.
3. Replace page information architecture and copy.
4. Rebuild chart/metric presentation with one denominator and visible freshness.
5. Implement complete async states.
6. Fix mobile overflow and accessibility.
7. Add real links, brand assets, and submission metadata.
8. Update presentation tests to enforce this audit.
9. Run desktop/mobile browser verification and attach screenshots to the handoff.

## Files Luna must preserve

- Keep `Writeup1.md`, `Architecture1.md`, `setup1.md`, phase result files, scripts, contract code, and tests as technical evidence.
- Do not change oracle math, pinned measurements, contract behavior, or source addresses as part of the frontend cleanup.
- Do not replace live reads with fabricated demo data.

## Handoff format required from Luna

When implementation is complete, report:

1. Files changed.
2. Public sections removed, moved, or replaced.
3. Exact data-provenance rule used for every comparison.
4. Desktop and mobile screenshots.
5. Runtime failure-state screenshots.
6. `forge test -vv` result.
7. Updated presentation-test result.
8. Any missing real URLs or assets still blocking submission.

