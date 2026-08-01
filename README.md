# RuralRelay

**An on-device care coordination agent for older adults — powered by Gemma.**

> Eleanor is 78 and lives 34 miles from her cardiologist. Finding an appointment
> is only the beginning: someone must check that the provider accepts her
> insurance, coordinate a time, find out whether her daughter can drive her,
> find accessible transportation if she cannot, and make sure everyone
> remembers the plan. RuralRelay handles that logistical work — the journey
> from "care is due" to "Eleanor gets through the door."

Built in one day for **Build with Gemma NYC: On-Device AI for Healthcare**
(Track: Agentic Care Copilots).

RuralRelay is decision-support for care **logistics only** — appointments,
rides, caregivers, reminders. It never diagnoses, never recommends medical
care, and uses only synthetic data.

## What it does

One complete workflow for one synthetic patient:

1. **Today** — a "Cardiology follow-up due" card appears because Eleanor
   entered a 6-month recurring plan (the app never infers medical need).
2. **Coordinate** — Gemma plans tool calls inside a state machine: find an
   in-network provider, match a morning slot, tentatively hold it.
3. **Ride** — the appointment is 34 miles away, so RuralRelay texts Eleanor's
   daughter Sarah. Gemma interprets her free-text reply ("I have work meetings
   all day Tuesday, sorry") into structured availability.
4. **Replan** — Sarah can't drive, so Gemma selects a walker-accessible
   transport option and explains the complete plan in plain language.
5. **Confirm** — nothing books until Eleanor approves. Then the care timeline
   updates and confirmations go out.

## How Gemma is used

All inference runs **locally via Ollama** (`gemma4:latest`) — the patient
profile never leaves the device. Gemma is central in five places
(see `gemma.py`):

| # | Role | Function |
|---|------|----------|
| 1 | Onboarding interpretation | free text → structured preferences |
| 2 | Action planning | chooses the next tool within state-machine rails |
| 3 | Response interpretation | caregiver SMS → structured availability |
| 4 | Constraint-aware replanning | picks fallback transport given mobility needs |
| 5 | Patient explanation | plain-language "why this plan fits you" |

Every Gemma output is JSON-constrained and validated; invalid output falls
back to deterministic logic so the coordination never stalls.

## Architecture

```
On-device Gemma (Ollama)
     ├── interprets onboarding
     ├── plans next tool call
     ├── interprets SMS replies
     └── explains the final plan
     ▼
Care coordination state machine (server.py)
  NEEDS_APPOINTMENT → APPOINTMENT_HELD → TRANSPORT_NEEDED
  → CAREGIVER_CONTACTED → CAREGIVER_UNAVAILABLE → TRANSPORT_FOUND
  → AWAITING_USER_CONFIRMATION → CONFIRMED
     ▼
Deterministic tools (tools.py) over synthetic datasets (data/)
  search_providers · check_availability · hold_appointment
  check_transport · reserve_transport · send_sms · create_calendar_event
```

The state machine passes Gemma only the tools that are valid transitions from
the current state, validates every choice, and requires explicit patient
confirmation before anything is finalized.

**Adaptive coordination:** a transparent preference score (Sarah has accepted
1 of 4 past ride requests) shifts the coordination order — RuralRelay lines up
accessible transport as a fallback while still asking Sarah first, keeping the
user in control.

**Privacy model:** the full care profile and all planning logic stay
on-device. Outbound messages contain only the minimum needed for the approved
action — appointment time and place, never history, medications, or insurance
details.

## Run it

```bash
# 1. Local Gemma via Ollama
ollama pull gemma4        # or edit MODEL in gemma.py (gemma3:4b also works)
ollama serve

# 2. Server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn server:app --port 8787

# 3. Open http://localhost:8787
```

Demo flow: **Today → Coordinate appointment**, watch the agent feed, reply as
Sarah in the phone simulator ("NO, I have work meetings all day Tuesday"),
review the plan, **Confirm appointment and ride**, then check the Care
Calendar. `POST /reset` resets between runs.

SMS is simulated in-app by default so the demo has no external dependency.
Setting `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, and
`CAREGIVER_PHONE` sends real texts, and a Twilio inbound webhook can point at
the same `/caregiver-response` endpoint the simulator uses.

## Roadmap

The same coordination engine extends to preventive-care planning, provider
discovery, and post-discharge prescription pickup (pharmacy confirmation +
caregiver or transport coordination) — each is another tool set behind the
same Gemma planner and confirmation gate.

## Safety scope

- Decision-support for logistics only; no diagnosis, no treatment, no
  care recommendations inferred from age or history.
- Synthetic data only (`data/`); no real patient data anywhere.
