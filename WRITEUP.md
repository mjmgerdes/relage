# Relage

## An on-device care coordination agent for older adults, powered by Gemma

**Track: Agentic Care Copilots**

---

### The problem

Eleanor is 78. She lives in rural Pennsylvania, uses a walker, and her
cardiologist is 34 miles away. Her cardiology follow-up is due — and finding
an appointment is only the beginning. Someone must check that the provider
accepts Medicare, coordinate a time she can manage, find out whether her
daughter Sarah can drive her, find walker-accessible transportation when
Sarah can't, and make sure everyone remembers the plan.

Today that "someone" is usually an overloaded family caregiver juggling all
of it by phone and text. When coordination fails, the appointment is missed —
not because care didn't exist, but because the patient couldn't get through
the door. Transportation is one of the most commonly cited non-clinical
barriers to care access in rural areas, and older adults with mobility needs
are hit hardest.

**Healthcare access is not whether a provider exists. It is whether the
patient can actually get through the door.**

### What Relage does

Relage is a care-access orchestration agent. It turns a healthcare need
into an appointment the patient can actually attend: it finds a feasible
in-network appointment, tentatively holds it, coordinates transportation with
the caregiver by SMS, interprets the reply, adapts when the caregiver is
unavailable by finding accessible transport, and asks the patient to approve
the complete appointment-and-ride plan before anything books. After
confirmation, the care timeline updates and confirmations and reminders go
out to both patient and caregiver.

It is decision-support for **logistics only**. The "cardiology follow-up due"
card exists because Eleanor entered a six-month recurring plan — Relage
never infers what medical care someone needs, never diagnoses, and never
recommends treatment. All data is synthetic.

### How Gemma is core

All inference runs locally through Ollama. Eleanor's full care profile and
all planning logic stay on-device; the only things that ever leave are the
minimum fields needed for an approved action (Sarah receives an appointment
time and place — never medical history, medications, or insurance details).

We decompose coordination into five subtasks and **route each to the
smallest Gemma that does it well** (`gemma.py`):

| # | Subtask | Model | Why |
|---|---------|-------|-----|
| 1 | Onboarding interpretation — free text → structured preferences | gemma3 4B | constrained JSON extraction, interactive latency |
| 2 | Action planning — next tool from the legal transitions | gemma 4 8B | reasoning over state + options |
| 3 | Response interpretation — caregiver reply (typed or spoken) → `can_drive`/`partial`/`constraint` | gemma3 4B | latency-critical: runs right after the caregiver answers (~1–2 s) |
| 4 | Constraint-aware replanning — pick fallback transport given walker + 34 miles | gemma 4 8B | multi-option tradeoff |
| 5 | Patient explanation — why this plan fits her preferences | gemma 4 8B | prose quality |

Both tiers are warmed at server startup and kept resident, so the first live
call has no cold-start. The technical activity feed stamps every inference
with its model and latency (e.g. `[gemma3:4b 1.9s]`), making the routing
visible to judges in real time.

### Architecture

```
On-device Gemma (Ollama, JSON-constrained)
        ▼
Care coordination state machine (FastAPI)
  NEEDS_APPOINTMENT → APPOINTMENT_HELD → TRANSPORT_NEEDED
  → CAREGIVER_CONTACTED → CAREGIVER_UNAVAILABLE → TRANSPORT_FOUND
  → AWAITING_USER_CONFIRMATION → CONFIRMED
        ▼
Deterministic tools over synthetic datasets
  search_providers · check_availability · hold_appointment · check_transport
  reserve_transport · send_sms · create_calendar_event
```

Three engineering choices matter here:

**The state machine is the spine, Gemma is the brain.** Every Gemma output is
JSON-schema-constrained (Ollama `format: json`, temperature 0.1) and
validated against the current state's set of legal tools. Invalid output
falls back to deterministic logic, so the coordination loop can never stall
or take an illegal action. This makes the agent feel robust rather than
improvised: the LLM plans and interprets; the machine guarantees safety and
progress.

**The caregiver loop reaches a real phone.** The conversation runs through a
`/caregiver-response` endpoint. In the demo UI, an embedded "Sarah's phone"
simulator posts to it — which keeps the demo deterministic — but the same
endpoint accepts Twilio's form-encoded inbound webhook unchanged. And because
US carriers block SMS from unregistered numbers (A2P 10DLC), we added a
Twilio Voice channel: Relage places a real call to the caregiver's phone,
asks the question with TTS, and feeds the speech transcription into the same
Gemma interpretation path. In live testing, a spoken "No, I've work that day"
was transcribed, interpreted as a decline, and the agent replanned to the
accessible van — a real phone, a real human answer, mid-workflow.

**Adaptation is transparent, not magical.** We do not claim to have trained a
personalized model in a day. Relage keeps a visible preference score —
Sarah has accepted 1 of her last 4 ride requests, while accessible transport
has worked 3 of 3 times — and adapts its coordination order accordingly:
it still asks Sarah first (Eleanor's stored preference keeps the user in
control) but lines up the accessible-transport fallback in advance. The
activity feed shows this reasoning to the user.

### The demo

The UI is **elder-first**: 22px+ type, one action per screen, plain language
("Holding that time for you — nothing is booked until you say OK"), and a
two-item navigation an 78-year-old can actually use. Home shows one due-care
card with one button; progress renders as a friendly checklist; the plan
review is three icon rows and a big "Yes, book everything." Everything
technical — the caregiver phone simulator, per-inference model/latency
telemetry, reset — lives in a collapsible demo drawer. A caregiver Setup
screen edits the full profile, with a free-text box Gemma structures live.
The care timeline shows the whole day: 8:55 AM pickup, 10:30 AM appointment,
12:15 PM return, and the next auto-coordinated follow-up window in February.

The judge-facing moment: Eleanor taps "Yes, help me book it," Gemma plans
tool calls live — then a **real phone rings**. The caregiver answers, hears
the ElevenLabs voice ask about the ride, and says "No, I can't — I've work
that day." The transcript hits gemma3 4B, the decline is understood, gemma4
8B replans around a walker and 34 miles, and a complete plan appears that
Eleanor — always — confirms herself. (No pickup? Relage auto-redials, up to
three attempts.)

### Challenges in the one-day sprint

- **Reliability vs. improvisation.** Early on, letting the model drive
  free-form broke the flow in confusing ways. Moving to an explicit state
  machine with per-state allowed tools, JSON-constrained outputs, and
  deterministic fallbacks made the demo dependable without making Gemma
  decorative — it still makes every interpretive and planning decision.
- **Latency.** An 8B local model takes seconds per call. We kept Gemma calls
  to the five decision points, routed the latency-critical extractions to the
  4B tier, pre-warmed both models at startup, and built the UI around a live
  activity feed so remaining inference time reads as the agent visibly
  working. Call audio is likewise pre-generated (ElevenLabs TTS, cached mp3)
  at dial time so the answered phone speaks instantly.
- **Scope discipline.** The full vision includes preventive-care planning,
  provider discovery, and post-discharge pharmacy pickup. We cut all of it
  and built one complete loop for one synthetic patient — because a finished
  story beats four half-built features.

### Why these choices were right

On-device Gemma is not a gimmick here: care logistics touch the most
sensitive facts about a person's life — where they live, who cares for them,
how they move, what care they receive. A cloud agent would leak all of that
by design. Relage's split — profile and planning local, minimum-necessary
fields shared per approved action — is an architecture that only works with a
capable local model, and Gemma 4's constrained-JSON planning and
natural-language interpretation were strong enough to carry all five roles.

### Roadmap

The same planner-plus-state-machine engine extends directly: preventive and
recurring-care planning, provider discovery, and post-discharge prescription
pickup (medication extraction → pharmacy readiness → pickup coordination with
the same caregiver/transport loop). Each is a new tool set behind the same
Gemma planner and the same patient confirmation gate.

---

*Synthetic data only. Decision-support for care logistics — not diagnosis or
treatment.*
