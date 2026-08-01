# Relage

## An on-device Gemma agent that turns "care is due" into an appointment an older adult can actually get to

**Track: Agentic Care Copilots**

---

### The problem

Eleanor is 78. She lives in rural Pennsylvania, uses a walker, and her
cardiologist is 34 miles away. Her follow-up is due — and finding an
appointment is only the beginning. Someone must confirm the practice takes
Medicare, coordinate a time she can manage, find out whether her daughter
Sarah can drive her, find walker-accessible transportation when Sarah can't,
and make sure everyone remembers the plan.

Today that "someone" is an overloaded family caregiver juggling it all by
phone and text. When coordination fails, care is missed — not because a
provider didn't exist, but because the patient couldn't get through the
door. Transportation is one of the most cited non-clinical barriers to care
in rural America, and older adults with mobility needs are hit hardest.

**Healthcare access is not whether a provider exists. It is whether the
patient can actually get through the door.**

### What Relage does

Relage (*relay + age*) is a care-access orchestration agent. From a
caregiver-entered recurring care plan, it surfaces what's due, finds a
feasible in-network appointment, tentatively holds it, **calls the
caregiver's real phone** to ask about the ride, interprets the spoken
answer, adapts when the caregiver is unavailable by finding accessible
transport, and presents one complete appointment-and-ride plan that the
patient — always — approves herself. After confirmation, the care timeline
updates and confirmations and reminders go out to patient and caregiver.

It is decision-support for **logistics only**. Care cards exist because a
person entered a recurring plan — Relage never infers medical need, never
diagnoses, never recommends treatment. All data is synthetic.

### How Gemma 4 is core

All inference runs locally through Ollama. We decompose coordination into
five subtasks and **route each to the smallest Gemma that does it well**
(`gemma.py`), measured live:

| # | Subtask | Model | Why | Measured |
|---|---------|-------|-----|----------|
| 1 | Onboarding interpretation — free text → structured preferences | gemma3 4B | constrained JSON extraction, interactive latency | ~1.9 s |
| 2 | Action planning — next tool from the state machine's legal transitions | gemma 4 8B | reasoning over state and options | ~10 s (background) |
| 3 | Response interpretation — caregiver's typed or *spoken* reply → `can_drive` / `partial` / `constraint` | gemma3 4B | latency-critical, runs while the patient watches | ~3 s |
| 4 | Constraint-aware replanning — fallback transport given walker + 34 miles | gemma 4 8B | multi-option tradeoff | ~12 s (background) |
| 5 | Patient explanation — why this plan fits her preferences | gemma 4 8B | warm, plain prose | ~10 s (background) |

Both tiers are pre-warmed at startup and kept resident, so the first live
inference has no cold-start. The demo drawer stamps every inference with its
model and latency (e.g. `[gemma3:4b 3.1s]`) — judges can watch the routing
happen in real time.

Gemma is not decorative here: it converts conversational onboarding into
structured preferences, decides which tool to call next, turns a messy
spoken sentence into a structured decision, chooses among transport options
under mobility constraints, and explains the result to a 78-year-old in
plain language. Every capability the demo shows runs through the model.

### Architecture: state machine spine, Gemma brain

```
On-device Gemma (Ollama, JSON-constrained, two tiers)
        ▼
Care coordination state machine (FastAPI)
  NEEDS_APPOINTMENT → APPOINTMENT_HELD → TRANSPORT_NEEDED
  → CAREGIVER_CONTACTED → CAREGIVER_UNAVAILABLE → TRANSPORT_FOUND
  → AWAITING_USER_CONFIRMATION → CONFIRMED
        ▼
Deterministic tools over synthetic datasets
  search_providers · check_availability · hold_appointment · check_transport
  reserve_transport · send_sms · place_call · eleven_tts · calendar
        ▼
Channels: elder-first web UI · Twilio Voice (ElevenLabs TTS, speech gather,
answering-machine detection, auto-redial) · SMS webhook
```

Every Gemma output is JSON-constrained (temperature 0.1) and validated
against the current state's set of legal tools; invalid output falls back to
deterministic logic, so the loop can never stall or take an illegal action.
Each step also shows its **sources** — Medicare Care Compare for the
in-network search, each practice's site for scheduling, county transit
directories for rides — as link chips in the activity feed (synthetic
datasets stand in for the real integrations).

### The caregiver loop reaches a real phone

Because US carriers block SMS from unregistered numbers (A2P 10DLC), we
built the real-device channel on **Twilio Voice**: Relage places an actual
call, speaks with a natural **ElevenLabs** voice (clips pre-generated at
dial time so the answered phone speaks instantly), gathers the spoken reply,
and feeds the transcription into the same Gemma interpretation path as SMS.

The edge cases got real fast. When nobody picks up, Relage auto-redials (up
to three attempts). When a **voicemail** answered mid-testing, its greeting
("your call has been forwarded to an automated voice messaging system…") was
transcribed and interpreted as a decline — so we added Twilio
answering-machine detection plus a transcript filter: machine pickups hang
up and redial; greeting phrases can never become the caregiver's answer.

In live testing: the phone rang, a human answered, said *"No, I can't — I've
work that day,"* Gemma 3 4B interpreted the decline from the transcript,
Gemma 4 8B replanned to a walker-accessible county medical van, and the
complete plan appeared for Eleanor's approval. A real phone, a real spoken
answer, mid-workflow.

### Adaptation, transparently

We do not claim to have trained a personalized model in a day. Relage keeps
a visible preference score — Sarah accepted 1 of her last 4 ride requests;
accessible transport worked 3 of 3 — and adapts its coordination order:
it still asks Sarah first (the patient's stored preference keeps her in
control) but lines up the fallback in advance. The reasoning is shown to the
user, not hidden.

### Privacy & safety

Care logistics touch the most sensitive facts of a person's life — where
they live, who cares for them, how they move. A cloud agent leaks all of it
by design. Relage's split only works because a capable local model exists:
the full profile and all planning logic stay on-device; outbound calls and
texts carry only the appointment time and place — never history,
medications, or insurance details. Decision-support only; synthetic data
only; the patient confirms before anything books.

### The demo

The UI is **elder-first**: a four-stage journey bar, one action per screen,
large type, plain language ("Holding that time for you — nothing is booked
until you say OK"). A first-run onboarding builds the profile — multiple
recurring appointments with addresses, pharmacy, caregiver — with a
one-tap "Load demo data" for judging. Due care gets a card and a button;
not-yet-due care shows its next window with auto-coordination on. Everything
technical (caregiver phone simulator, per-inference model/latency telemetry,
source chips, reset) lives in a demo drawer.

Live demo: hosted replay at **mjmgerdes.github.io/relage** (GitHub Pages,
replays a recorded on-device run) plus the full live instance — local Gemma,
real phone call on stage — during judging.

### Challenges in the one-day sprint

- **Reliability vs. improvisation.** Free-form model-driven flow broke
  confusingly; the explicit state machine with per-state tool allow-lists
  and deterministic fallbacks made the demo dependable while Gemma still
  makes every interpretive and planning decision.
- **Telephony reality.** A2P carrier blocks, spam screening, and voicemail
  transcripts each broke the loop in a different way; the voice channel with
  AMD, redial, and transcript filtering came from live failures, not
  speculation.
- **Scope discipline.** The vision includes provider discovery and
  post-discharge pharmacy pickup. We cut everything but one complete loop
  for one synthetic patient — a finished story beats four half-built
  features.

### Roadmap

The same planner-plus-state-machine engine extends directly: preventive-care
planning, provider discovery, and post-discharge prescription pickup
(medication extraction → pharmacy readiness → the same caregiver/transport
loop). Each is a new tool set behind the same Gemma planner and the same
patient confirmation gate.

---

*Synthetic data only. Decision-support for care logistics — not diagnosis or
treatment.*
