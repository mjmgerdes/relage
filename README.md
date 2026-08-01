# Relage

**An on-device care coordination agent for older adults — powered by Gemma.**
*(Relage = relay + age)*

> Eleanor is 78 and lives 34 miles from her cardiologist. Finding an
> appointment is only the beginning: someone must check that the provider
> accepts her insurance, coordinate a time, find out whether her daughter can
> drive her, find walker-accessible transportation when she can't, and make
> sure everyone remembers the plan. Relage handles that logistical work — the
> journey from "care is due" to "Eleanor gets through the door."

Built in one day for **Build with Gemma NYC: On-Device AI for Healthcare**
(Track: Agentic Care Copilots).

🔗 **Live demo (hosted replay):** https://mjmgerdes.github.io/relage/
📄 **Kaggle writeup:** `WRITEUP.md`

Relage is decision-support for care **logistics only** — appointments, rides,
caregivers, reminders. It never diagnoses, never recommends medical care, and
uses only synthetic data.

---

## How we use Gemma (the interesting part)

All inference runs **locally via Ollama**. The patient's full profile and all
planning logic stay on-device; external services receive only the minimum
fields needed for an action the patient approved.

We decompose care coordination into five subtasks and **route each to the
smallest Gemma that does it well** (`gemma.py`):

| # | Subtask | Model | Why | Measured |
|---|---------|-------|-----|----------|
| 1 | Onboarding interpretation — free text → structured preferences | **gemma3 4B** | constrained JSON extraction, interactive latency | ~1.9 s |
| 2 | Action planning — choose the next tool from the state machine's legal transitions | **gemma4 8B** | reasoning over state + options | ~10 s (background) |
| 3 | Response interpretation — caregiver's typed or *spoken* reply → `can_drive` / `partial` / `constraint` | **gemma3 4B** | latency-critical: runs right after the caregiver answers | ~3 s |
| 4 | Constraint-aware replanning — pick fallback transport given walker + 34 miles | **gemma4 8B** | multi-option tradeoff | ~12 s (background) |
| 5 | Patient explanation — why this plan fits her preferences | **gemma4 8B** | warm, plain prose | ~10 s (background) |

Engineering around the models:

- **State machine is the spine, Gemma is the brain.** Every output is
  JSON-constrained (Ollama `format: json`, temp 0.1) and validated against the
  current state's set of legal tools. Invalid output falls back to
  deterministic logic — the loop can never stall or take an illegal action.
- **Pre-warmed, kept resident.** Both tiers load at server startup with
  `keep_alive`, so the first live inference has no cold-start.
- **Visible routing.** The technical activity feed stamps every inference
  with its model and latency (e.g. `[gemma3:4b 3.1s]`) — you can watch the
  routing happen during the demo.
- **Human confirmation gate.** Nothing books until the patient approves the
  complete plan.

## The demo flow

One complete story for one synthetic patient:

Five screens: **Profile · Today · Coordinate · Ride · Care Calendar.**

1. **Today** — "Cardiology Follow-Up due" exists because Eleanor entered a
   6-month recurring plan (the app never infers medical need). One button:
   *"Coordinate appointment."*
2. **Coordinate** — Gemma plans tool calls inside the state machine: find an
   in-network provider, match a morning slot, hold it. Plain-language
   progress for Eleanor, with tool calls, model routing, and per-call latency
   in an expandable agent-activity panel.
3. **Ride — real phone call** — the appointment is 34 miles away. Relage
   **calls the caregiver's actual phone** (Twilio Voice + ElevenLabs TTS),
   asks whether she can drive, and transcribes the spoken answer.
4. **Ride — adapt** — "No, I can't — I've work that day" → gemma3 4B
   interprets the transcript → gemma4 8B replans to a walker-accessible
   medical van and explains the plan in plain language. The same screen shows
   *why Sarah was asked first* (1 of 4 past requests accepted).
5. **Confirm** — Eleanor reviews and approves on the Ride screen; the **Care
   Calendar** updates (8:55 AM pickup → 10:30 AM appointment → 12:15 PM
   return) and confirmations go out.

If the caregiver doesn't pick up, Relage **auto-redials** (up to 3 attempts).
An in-app phone simulator covers the SMS path with zero external
dependencies — the same `/caregiver-response` endpoint accepts Twilio's real
inbound webhook unchanged.

## Architecture

```
On-device Gemma (Ollama, JSON-constrained, two tiers)
   gemma3 4B — fast structured extraction     gemma4 8B — planning/explanation
        ▼
Care coordination state machine (FastAPI, server.py)
  NEEDS_APPOINTMENT → APPOINTMENT_HELD → TRANSPORT_NEEDED
  → CAREGIVER_CONTACTED → CAREGIVER_UNAVAILABLE → TRANSPORT_FOUND
  → AWAITING_USER_CONFIRMATION → CONFIRMED
        ▼
Deterministic tools (tools.py) over synthetic datasets (data/)
  search_providers · check_availability · hold_appointment · check_transport
  reserve_transport · send_sms · place_call · eleven_tts · calendar
        ▼
Channels: elder-first web UI · Twilio Voice (ElevenLabs TTS, speech gather,
auto-redial) · SMS webhook (simulator in demo; real Twilio-compatible)
```

**Adaptive coordination:** a transparent preference score (Sarah accepted 1
of 4 past ride requests; accessible transport 3 of 3) shifts coordination
order — Relage still asks Sarah first per Eleanor's stored preference, but
lines up the fallback in advance. No "we trained a model" claims; the
reasoning is shown to the user.

**Privacy model:** profile + planning stay on-device. Outbound messages and
calls contain only appointment time and place — never history, medications,
or insurance details.

**Elder-first UI:** 22px+ type, one action per screen, plain language
("Holding that time for you — nothing is booked until you say OK"), two-item
navigation. All technical surfaces (caregiver phone simulator, agent
telemetry, reset) live in a demo drawer. A caregiver Setup screen edits the
full profile and includes a free-text box Gemma structures on the spot.

## Run it

```bash
# 1. Local Gemma via Ollama (both tiers)
ollama pull gemma4 && ollama pull gemma3:4b
ollama serve

# 2. Server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn server:app --port 8787

# 3. Open http://localhost:8787
```

Optional real telephony (`.env`, see `.env.example`): `TWILIO_*` credentials,
`CAREGIVER_PHONE`, `BASE_URL` (an `ngrok http 8787` tunnel for the
speech-gather and status webhooks), `ELEVENLABS_API_KEY` for the natural
voice. Without any of it, the in-app simulator carries the whole flow.

Note: SMS from unregistered US local numbers is carrier-blocked (A2P 10DLC),
which is why the real-device channel is voice — see `WRITEUP.md`.

Between demo runs: demo drawer → *Reset demo* (or `POST /reset`).

## Repository map

```
server.py        state machine, agent workers, voice/SMS webhooks, API
gemma.py         two-tier Gemma routing, prompts, warm-up, telemetry
tools.py         deterministic tools: providers, transport, SMS, calls, TTS
data/            synthetic patient, provider, and transport datasets
static/          elder-first single-page UI (+ generated TTS cache)
docs/            GitHub Pages build — same UI with a recorded-run replay shim
WRITEUP.md       Kaggle writeup
```

## Roadmap

The same planner-plus-state-machine engine extends directly: preventive-care
planning, provider discovery, and post-discharge prescription pickup
(medication extraction → pharmacy readiness → the same caregiver/transport
loop). Each is a new tool set behind the same Gemma planner and the same
patient confirmation gate.

## Safety scope

- Decision-support for logistics only; no diagnosis, no treatment, no care
  recommendations inferred from age or history.
- Synthetic or public data only; no real patient data anywhere.
