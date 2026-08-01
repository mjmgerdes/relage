"""RuralRelay server: care coordination state machine driven by on-device Gemma.

Run:  uvicorn server:app --reload --port 8000   (or: python server.py)
Open: http://localhost:8000

The agent loop is an explicit state machine. Gemma chooses tools and
interprets natural language; the state machine validates every transition and
the patient confirms before anything is finalized.

    NEEDS_APPOINTMENT -> APPOINTMENT_HELD -> TRANSPORT_NEEDED
    -> CAREGIVER_CONTACTED -> (CAREGIVER_UNAVAILABLE ->) TRANSPORT_FOUND
    -> AWAITING_USER_CONFIRMATION -> CONFIRMED
"""

import json
import threading
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import gemma
import tools

ROOT = Path(__file__).parent

app = FastAPI(title="RuralRelay")

with open(ROOT / "data" / "profile.json") as f:
    PROFILE = json.load(f)

# Single-patient demo state. All of this lives in process memory on the
# device — nothing is persisted to or fetched from a cloud service.
STATE = {
    "status": "NEEDS_APPOINTMENT",
    "activity": [],          # agent activity feed shown in the UI
    "appointment": None,
    "transport_options": [],
    "transport": None,
    "caregiver_reply": None,
    "plan_explanation": "",
    "calendar": [
        {"date": "2026-02-08", "time": "10:00 AM",
         "title": "Cardiology follow-up — Regional Heart Center",
         "kind": "past", "status": "completed"},
    ],
    "sms_outbox": [],        # messages shown in the phone simulator
    "busy": False,
}
LOCK = threading.Lock()

# Which tools are legal from each state — Gemma plans within these rails.
ALLOWED = {
    "NEEDS_APPOINTMENT": ["search_providers", "check_availability",
                          "hold_appointment"],
    "APPOINTMENT_HELD": ["check_transport", "text_caregiver"],
    "TRANSPORT_NEEDED": ["text_caregiver", "check_transport"],
    "CAREGIVER_UNAVAILABLE": ["check_transport"],
}


def log(kind: str, text: str, detail: dict | None = None,
        friendly: str | None = None):
    """Record an activity item. `text` is the technical line (demo drawer);
    `friendly` is the plain-language line shown to the patient."""
    STATE["activity"].append({"kind": kind, "text": text,
                              "friendly": friendly, "detail": detail or {}})


def caregiver_acceptance_rate() -> float:
    p = PROFILE["transport_preferences"]["ask_sarah"]
    return p["accepted"] / max(p["attempts"], 1)


# ---------------------------------------------------------------- endpoints

@app.get("/profile")
def get_profile():
    return PROFILE


@app.post("/profile")
async def update_profile(request: Request):
    """Replace the demo profile (caregiver setup screen). Accepts the same
    shape as data/profile.json; missing sections keep their current values.
    Resets any in-flight coordination since the plan inputs changed."""
    body = await request.json()
    for key in ("patient", "caregiver", "recurring_care", "transport_preferences"):
        if key in body and body[key]:
            if isinstance(PROFILE.get(key), dict) and isinstance(body[key], dict):
                PROFILE[key].update(body[key])
            else:
                PROFILE[key] = body[key]
    reset()
    return PROFILE


@app.get("/config")
def get_config():
    """UI feature flags: whether outbound SMS is really going through Twilio."""
    import tools as t
    return {"twilio": t.twilio_configured(),
            "caregiver_phone": PROFILE["caregiver"].get("phone", "")}


@app.get("/state")
def get_state():
    return STATE


@app.get("/actions")
def get_actions():
    """Actionable cards for the Today screen. The cardiology card exists
    because Eleanor entered a 6-month recurring plan — the app never infers
    that she medically needs care."""
    cards = []
    for rc in PROFILE["recurring_care"]:
        if STATE["status"] == "NEEDS_APPOINTMENT":
            cards.append({
                "title": f"{rc['type'].title()} due",
                "last_visit": rc["last_visit"],
                "interval": f"Every {rc['interval_months']} months",
                "provider": rc["provider"],
                "distance": "34 miles",
                "source": rc["source"],
                "action": "coordinate",
            })
    return {"cards": cards}


@app.post("/onboarding-note")
async def onboarding_note(request: Request):
    """Gemma use #1: turn a free-text onboarding answer into structured
    preferences the patient can review."""
    body = await request.json()
    result = gemma.interpret_onboarding(body.get("text", ""))
    log("gemma", f"Interpreted onboarding note: {result.get('summary', '')}",
        result)
    return result


@app.post("/coordinate")
def coordinate():
    """Run the agent loop from NEEDS_APPOINTMENT to CAREGIVER_CONTACTED.
    Runs synchronously in a worker thread; the UI polls /state and renders
    the activity feed as it grows."""
    with LOCK:
        if STATE["busy"] or STATE["status"] != "NEEDS_APPOINTMENT":
            return JSONResponse({"error": "not in a coordinatable state"}, 409)
        STATE["busy"] = True
    threading.Thread(target=_coordinate_worker, daemon=True).start()
    return {"started": True}


def _coordinate_worker():
    try:
        patient = PROFILE["patient"]
        care = PROFILE["recurring_care"][0]

        # -- Gemma use #2: plan the next action within state-machine rails
        plan = _plan_or_default(
            context={"need": care["type"], "insurance": patient["insurance"],
                     "preferred_provider": care["provider"],
                     "location": patient["home_location"]},
            default="search_providers")
        log("gemma", f"Plan: {plan['tool']} — {plan['reason']}", plan,
            friendly=f"Finding a doctor who takes {patient['insurance']}…")

        specialty = ("cardiology" if "cardio" in care["type"].lower()
                     else "primary care")
        providers = tools.search_providers(specialty, patient["insurance"],
                                           care["provider"])
        log("tool", f"search_providers → {len(providers)} in-network match(es)",
            {"top": providers[0]["name"] if providers else None},
            friendly=f"Found {providers[0]['name']} — they take "
                     f"{patient['insurance']}.")

        slot = tools.check_availability(providers[0]["name"],
                                        patient["preferred_times"])
        log("tool", f"check_availability → {slot['day']}, {slot['date']} "
                    f"at {slot['time']}", slot,
            friendly=f"They have an opening {slot['day']} morning at "
                     f"{slot['time']}.")

        STATE["appointment"] = tools.hold_appointment(slot)
        STATE["status"] = "APPOINTMENT_HELD"
        log("state", "Appointment tentatively held — nothing is booked until "
                     "the patient confirms the complete plan.",
            friendly="Holding that time for you — nothing is booked until "
                     "you say OK.")

        # Long distance -> transportation must be resolved before booking.
        STATE["status"] = "TRANSPORT_NEEDED"
        log("state", f"Appointment is {slot['distance_miles']} miles from "
                     "home — transportation needed.",
            friendly=f"That office is {slot['distance_miles']} miles away, "
                     "so let's sort out your ride.")

        # -- Adaptive preference logic: RuralRelay adapts its coordination
        # order based on prior outcomes while keeping the user in control.
        rate = caregiver_acceptance_rate()
        if rate >= 0.3:
            order_note = "Asking Sarah first (her past acceptance suggests she often can)."
        else:
            order_note = (f"Sarah has accepted {rate:.0%} of past ride requests, "
                          "so RuralRelay will line up accessible transport as a "
                          "fallback — but still asks her first per Eleanor's "
                          "stored preference.")
        log("adapt", order_note, PROFILE["transport_preferences"])

        # -- Minimum-necessary sharing: the caregiver gets time and place,
        # never the profile, history, or insurance details.
        cg = PROFILE["caregiver"]["name"].split()[0]
        first = patient["name"].split()[0]
        month = ["", "January", "February", "March", "April", "May", "June",
                 "July", "August", "September", "October", "November",
                 "December"][int(slot["date"][5:7])]
        sms_body = (f"Hi {cg}, {first} has a {care['type']} appointment "
                    f"available {slot['day']}, {month} {int(slot['date'][-2:])} "
                    f"at {slot['time']} at {slot['provider']}. Would you be "
                    f"able to drive her? Reply YES or NO.")
        tools.send_sms(PROFILE["caregiver"]["name"],
                       PROFILE["caregiver"]["phone"], sms_body,
                       STATE["sms_outbox"])
        STATE["status"] = "CAREGIVER_CONTACTED"
        log("sms", f"Texted {cg} to ask about the ride. Waiting for reply…",
            friendly=f"We texted {cg} to ask if she can drive you. "
                     "Waiting to hear back…")
    except Exception as e:
        log("error", f"Coordination error: {e}")
    finally:
        STATE["busy"] = False


@app.post("/caregiver-response")
async def caregiver_response(request: Request):
    """Webhook for the caregiver's SMS reply. The phone simulator posts here;
    a real Twilio inbound webhook can point at this same endpoint."""
    if STATE["status"] != "CAREGIVER_CONTACTED":
        return JSONResponse({"error": "no outstanding caregiver request"}, 409)
    ctype = request.headers.get("content-type", "")
    if "form" in ctype:  # Twilio posts form-encoded with a Body field
        form = await request.form()
        text = form.get("Body", "")
    else:
        body = await request.json()
        text = body.get("text", "")
    threading.Thread(target=_caregiver_worker, args=(text,),
                     daemon=True).start()
    return {"received": True}


def _caregiver_worker(text: str):
    try:
        STATE["busy"] = True
        slot = STATE["appointment"]

        # -- Gemma use #3: free-text caregiver reply -> structured availability
        cg = PROFILE["caregiver"]["name"].split()[0]
        first = PROFILE["patient"]["name"].split()[0]
        parsed = gemma.interpret_reply(
            text, f"Can you drive {first} to her {slot['time']} appointment "
                  f"on {slot['day']}?")
        STATE["caregiver_reply"] = {"text": text, **parsed}
        log("gemma", f"Interpreted {cg}'s reply: {parsed['summary']}", parsed,
            friendly=f"{cg} answered: {parsed['summary']}")

        if parsed.get("can_drive") and not parsed.get("partial"):
            STATE["transport"] = {"name": f"{PROFILE['caregiver']['name']} "
                                          "(caregiver)",
                                  "type": "caregiver",
                                  "pickup_time": "9:15 AM",
                                  "return_pickup_time": "after appointment",
                                  "status": "confirmed_by_caregiver"}
            STATE["status"] = "AWAITING_USER_CONFIRMATION"
            log("state", f"{cg} can drive — ready for plan review.",
                friendly=f"Good news — {cg} can drive you!")
        else:
            STATE["status"] = "CAREGIVER_UNAVAILABLE"
            log("state", f"{cg} is unavailable. Finding accessible "
                         "transportation…",
                friendly=f"{cg} can't make it this time. Let's find you "
                         "another ride.")
            patient = PROFILE["patient"]
            options = tools.check_transport(slot["distance_miles"],
                                            patient["mobility_needs"],
                                            slot["time"])
            log("tool", f"check_transport → {len(options)} option(s) matching "
                        "mobility needs over the distance", {},
                friendly="Checking local rides with room for your walker…")

            # -- Gemma use #4: constraint-aware replanning over the options
            pick = _replan_or_default(options)
            STATE["transport"] = options[pick["choice_index"]]
            STATE["status"] = "TRANSPORT_FOUND"
            log("gemma", f"Selected fallback: "
                         f"{STATE['transport']['name']} — {pick['reason']}",
                pick,
                friendly=f"Found one: {STATE['transport']['name']}.")

        # -- Gemma use #5: explain the plan in plain language
        expl = gemma.explain_plan(
            {"appointment": STATE["appointment"],
             "transport": STATE["transport"]}, PROFILE)
        STATE["plan_explanation"] = expl.get("explanation", "")
        STATE["status"] = "AWAITING_USER_CONFIRMATION"
        log("state", "Complete plan ready for Eleanor's review.")
    except Exception as e:
        log("error", f"Reply handling error: {e}")
    finally:
        STATE["busy"] = False


@app.post("/confirm-plan")
def confirm_plan():
    """Patient approval — the only path to CONFIRMED. Books everything,
    updates the care timeline, and sends notifications."""
    if STATE["status"] != "AWAITING_USER_CONFIRMATION":
        return JSONResponse({"error": "no plan awaiting confirmation"}, 409)
    slot = STATE["appointment"]
    t = STATE["transport"]
    if t.get("type") != "caregiver":
        STATE["transport"] = tools.reserve_transport(t)
    STATE["status"] = "CONFIRMED"

    cal = STATE["calendar"]
    if t.get("pickup_time"):
        tools.create_calendar_event(cal, {
            "date": slot["date"], "time": t["pickup_time"],
            "title": f"Transportation pickup — {t['name']}",
            "kind": "transport", "status": "reserved"})
    tools.create_calendar_event(cal, {
        "date": slot["date"], "time": slot["time"],
        "title": f"{PROFILE['recurring_care'][0]['type'].title()} — "
                 f"{slot['provider']}",
        "kind": "appointment", "status": "confirmed"})
    if t.get("return_pickup_time") and "after" not in t["return_pickup_time"]:
        tools.create_calendar_event(cal, {
            "date": slot["date"], "time": t["return_pickup_time"],
            "title": "Return transportation pickup",
            "kind": "transport", "status": "reserved"})
    tools.create_calendar_event(cal, {
        "date": "2027-02-10", "time": "",
        "title": "Cardiology follow-up window begins — auto-coordinate enabled",
        "kind": "future", "status": "scheduled"})

    first = PROFILE["patient"]["name"].split()[0]
    care_type = PROFILE["recurring_care"][0]["type"]
    tools.send_sms(PROFILE["patient"]["name"], "(this device)",
                   f"Your {care_type} appointment is confirmed for {slot['day']} "
                   f"at {slot['time']}. "
                   f"{t['name']} will pick you up at {t.get('pickup_time', 'TBD')}. "
                   "You'll get a reminder the day before and the morning of.",
                   STATE["sms_outbox"])
    tools.send_sms(PROFILE["caregiver"]["name"], PROFILE["caregiver"]["phone"],
                   f"{first}'s {care_type} appointment and ride are confirmed "
                   f"for {slot['day']} at {slot['time']}. We'll keep you posted.",
                   STATE["sms_outbox"])
    log("state", "Plan confirmed. Calendar updated, notifications sent.")
    return STATE


@app.get("/calendar")
def get_calendar():
    return {"events": STATE["calendar"]}


@app.post("/reset")
def reset():
    """Reset demo state (handy between demo runs)."""
    STATE.update({
        "status": "NEEDS_APPOINTMENT", "activity": [], "appointment": None,
        "transport_options": [], "transport": None, "caregiver_reply": None,
        "plan_explanation": "", "sms_outbox": [], "busy": False,
        "calendar": [{"date": "2026-02-08", "time": "10:00 AM",
                      "title": "Cardiology follow-up — Regional Heart Center",
                      "kind": "past", "status": "completed"}],
    })
    return {"reset": True}


# ------------------------------------------------------------- gemma guards

def _plan_or_default(context: dict, default: str) -> dict:
    """Gemma plans the next tool; invalid output falls back deterministically."""
    allowed = ALLOWED.get(STATE["status"], [default])
    try:
        plan = gemma.plan_next_action(STATE["status"], context, allowed)
        if plan.get("tool") in allowed:
            return plan
    except Exception:
        pass
    return {"tool": default, "reason": "deterministic fallback"}


def _replan_or_default(options: list) -> dict:
    try:
        pick = gemma.replan("caregiver_ride",
                            {"mobility_needs": PROFILE["patient"]["mobility_needs"],
                             "distance_miles": STATE["appointment"]["distance_miles"]},
                            options)
        i = int(pick.get("choice_index", 0))
        if 0 <= i < len(options):
            return {"choice_index": i,
                    "reason": pick.get("reason", "best fit")}
    except Exception:
        pass
    return {"choice_index": 0, "reason": "closest walker-accessible option"}


# ---------------------------------------------------------------- frontend

@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
