"""Relage server: care coordination state machine driven by on-device Gemma.

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

app = FastAPI(title="Relage")

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


# Warm both Gemma tiers at startup so the first live call has no cold-start.
gemma.warm_up()


def gmeta() -> str:
    """Model + latency tag for the technical feed, e.g. ' [gemma3:4b 1.2s]'."""
    m = gemma.last_meta
    return f" [{m.get('model', '?')} {m.get('ms', 0) / 1000:.1f}s]" if m else ""


def log(kind: str, text: str, detail: dict | None = None,
        friendly: str | None = None, sources: list | None = None):
    """Record an activity item. `text` is the technical line (demo drawer);
    `friendly` is the plain-language line shown to the patient; `sources`
    are the places the agent consulted for this step, rendered as link
    chips (synthetic datasets stand in for the real integrations)."""
    STATE["activity"].append({"kind": kind, "text": text,
                              "friendly": friendly, "sources": sources or [],
                              "detail": detail or {}})


def src(label: str, query: str | None = None, url: str | None = None) -> dict:
    """A source chip. Fictional practices get a safe search URL rather than
    an invented domain that might resolve to someone's real site."""
    import urllib.parse
    if not url:
        url = ("https://www.google.com/search?q="
               + urllib.parse.quote(query or label))
    return {"label": label, "url": url}


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
    import os
    import tools as t
    voice = bool(t.twilio_configured() and os.environ.get("BASE_URL")
                 and os.environ.get("CAREGIVER_PHONE"))
    sms = bool(t.twilio_configured()
               and not os.environ.get("TWILIO_SMS_DISABLED"))
    return {"twilio": sms, "voice": voice,
            "voice_to": os.environ.get("CAREGIVER_PHONE", ""),
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
    log("gemma", f"Interpreted onboarding note: "
                 f"{result.get('summary', '')}{gmeta()}", result)
    return result


@app.post("/coordinate")
async def coordinate(request: Request):
    """Run the agent loop from NEEDS_APPOINTMENT to CAREGIVER_CONTACTED.
    Accepts {"index": n} to pick which recurring-care entry to coordinate.
    Runs in a worker thread; the UI polls /state for the activity feed."""
    idx = 0
    try:
        body = await request.json()
        idx = int(body.get("index", 0))
    except Exception:
        pass
    if not (0 <= idx < len(PROFILE["recurring_care"])):
        idx = 0
    with LOCK:
        if STATE["busy"] or STATE["status"] != "NEEDS_APPOINTMENT":
            return JSONResponse({"error": "not in a coordinatable state"}, 409)
        STATE["busy"] = True
    threading.Thread(target=_coordinate_worker, args=(idx,),
                     daemon=True).start()
    return {"started": True}


def _coordinate_worker(idx: int = 0):
    try:
        patient = PROFILE["patient"]
        care = PROFILE["recurring_care"][idx]
        STATE["care_index"] = idx

        # -- Gemma use #2: plan the next action within state-machine rails
        plan = _plan_or_default(
            context={"need": care["type"], "insurance": patient["insurance"],
                     "preferred_provider": care["provider"],
                     "location": patient["home_location"]},
            default="search_providers")
        log("gemma", f"Plan: {plan['tool']} — {plan['reason']}{gmeta()}", plan,
            friendly=f"Finding a doctor who takes {patient['insurance']}…",
            sources=[src("medicare.gov/care-compare",
                         url="https://www.medicare.gov/care-compare/")])

        specialty = ("cardiology" if "cardio" in care["type"].lower()
                     else "primary care")
        providers = tools.search_providers(specialty, patient["insurance"],
                                           care["provider"])
        log("tool", f"search_providers → {len(providers)} in-network match(es)",
            {"top": providers[0]["name"] if providers else None},
            friendly=f"Found {providers[0]['name']} — they take "
                     f"{patient['insurance']}.",
            sources=[src(p.get("website", p["name"]),
                         f"{p['name']} {p['location']}")
                     for p in providers[:3]])

        slot = tools.check_availability(providers[0]["name"],
                                        patient["preferred_times"])
        log("tool", f"check_availability → {slot['day']}, {slot['date']} "
                    f"at {slot['time']}", slot,
            friendly=f"They have an opening {slot['day']} morning at "
                     f"{slot['time']}.",
            sources=[src(f"{providers[0].get('website', '')} · scheduling",
                         f"{providers[0]['name']} {providers[0]['location']} "
                         "appointments")])

        slot["care_type"] = care["type"]
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

        # -- Adaptive preference logic: Relage adapts its coordination
        # order based on prior outcomes while keeping the user in control.
        rate = caregiver_acceptance_rate()
        if rate >= 0.3:
            order_note = "Asking Sarah first (her past acceptance suggests she often can)."
        else:
            order_note = (f"Sarah has accepted {rate:.0%} of past ride requests, "
                          "so Relage will line up accessible transport as a "
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

        voice_ready = (tools.twilio_configured()
                       and _os.environ.get("BASE_URL")
                       and _os.environ.get("CAREGIVER_PHONE"))
        if voice_ready:
            # Voice is the primary channel: call the caregiver's real phone.
            # The SMS above still lands in the simulator as the paper trail.
            try:
                STATE["call_attempts"] = 0
                _pregenerate_tts()
                _place_caregiver_call()
                log("sms", f"Also queued the ask as a text for {cg}.",
                    friendly=f"We're calling {cg} to ask if she can drive "
                             "you. Waiting for her to pick up…")
            except Exception as e:
                log("error", f"Auto-call failed: {e}",
                    friendly=f"Couldn't reach {cg} by phone — we texted "
                             "instead.")
        else:
            log("sms", f"Texted {cg} to ask about the ride. Waiting for "
                       "reply…",
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
        log("gemma", f"Interpreted {cg}'s reply: {parsed['summary']}{gmeta()}",
            parsed, friendly=f"{cg} answered: {parsed['summary']}")

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
                friendly="Checking local rides with room for your walker…",
                sources=[src(o.get("website", o["name"]),
                             f"{o['name']} Pennsylvania")
                         for o in options[:3]]
                        + [src("findarideguide.org (PA rural transit)",
                               "Pennsylvania rural medical transportation "
                               "directory")])

            # -- Gemma use #4: constraint-aware replanning over the options
            pick = _replan_or_default(options)
            STATE["transport"] = options[pick["choice_index"]]
            STATE["status"] = "TRANSPORT_FOUND"
            log("gemma", f"Selected fallback: "
                         f"{STATE['transport']['name']} — "
                         f"{pick['reason']}{gmeta()}",
                pick,
                friendly=f"Found one: {STATE['transport']['name']}.")

        # -- Gemma use #5: explain the plan in plain language
        expl = gemma.explain_plan(
            {"appointment": STATE["appointment"],
             "transport": STATE["transport"]}, PROFILE)
        STATE["plan_explanation"] = expl.get("explanation", "")
        log("gemma", f"Wrote plan explanation{gmeta()}")
        STATE["status"] = "AWAITING_USER_CONFIRMATION"
        log("state", "Complete plan ready for review.")
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
        "title": f"{slot.get('care_type', 'appointment').title()} — "
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
    care_type = slot.get("care_type",
                         PROFILE["recurring_care"][0]["type"])
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


# ------------------------------------------------------------ voice channel
# SMS from unregistered US local numbers is carrier-blocked (A2P 10DLC), but
# voice is not: Relage can CALL the caregiver, ask the question with TTS,
# and run the spoken answer through the same Gemma interpretation path the
# SMS webhook uses.

import os as _os
from fastapi.responses import Response as _Response


MAX_CALL_ATTEMPTS = 3
REDIAL_DELAY_S = 8


def _call_texts() -> dict:
    """The three utterances a call can need, built from current state."""
    slot = STATE["appointment"] or {}
    cg = PROFILE["caregiver"]["name"].split()[0]
    first = PROFILE["patient"]["name"].split()[0]
    care = slot.get("care_type", PROFILE["recurring_care"][0]["type"])
    return {
        "ask": (f"Hello {cg}, this is Rel Age calling on behalf of {first}. "
                f"She has a {care} appointment available {slot.get('day', '')} "
                f"at {slot.get('time', '')} at {slot.get('provider', '')}. "
                "Would you be able to drive her? Take your time — just say "
                "something like: yes I can, or, no I have work that day."),
        "retry": ("Sorry, we did not catch that. Would you be able to drive "
                  "her? Just say yes or no, with any details."),
        "thanks": ("Thank you. Rel Age will take it from here and keep "
                   "everyone updated. Goodbye."),
        "giveup": "No problem — Rel Age will follow up by text. Goodbye.",
    }


def _pregenerate_tts():
    """Generate ElevenLabs audio for all call utterances before dialing so
    the answered call plays instantly. No-op without an API key."""
    STATE["tts"] = {}
    for key, text in _call_texts().items():
        name = tools.eleven_tts(text)
        if name:
            STATE["tts"][key] = name
    if STATE["tts"]:
        log("call", f"ElevenLabs TTS ready ({len(STATE['tts'])} clips)")


def _place_caregiver_call() -> dict:
    base = _os.environ["BASE_URL"]
    to = _os.environ.get("CAREGIVER_PHONE") or PROFILE["caregiver"]["phone"]
    call = tools.place_call(to, f"{base}/voice-twiml",
                            status_callback=f"{base}/call-status")
    STATE["call_attempts"] = STATE.get("call_attempts", 0) + 1
    cg = PROFILE["caregiver"]["name"].split()[0]
    log("call", f"Placed voice call to {to} "
                f"(attempt {STATE['call_attempts']}, sid {call.get('sid', '?')})",
        friendly=f"Calling {cg}'s phone to ask about the ride…")
    return call


@app.post("/call-caregiver")
def call_caregiver():
    """Place a real call to the caregiver asking about the ride."""
    if STATE["status"] != "CAREGIVER_CONTACTED":
        return JSONResponse({"error": "no outstanding caregiver request"}, 409)
    if not _os.environ.get("BASE_URL") or not tools.twilio_configured():
        return JSONResponse({"error": "voice not configured "
                             "(need BASE_URL + TWILIO_* in .env)"}, 409)
    try:
        STATE["call_attempts"] = 0
        _pregenerate_tts()
        _place_caregiver_call()
        return {"placed": True}
    except Exception as e:
        log("error", f"Call failed: {e}")
        return JSONResponse({"error": str(e)}, 500)


@app.post("/call-status")
async def call_status(request: Request):
    """Twilio's final-status callback. If the caregiver didn't pick up,
    automatically redial after a short pause (up to MAX_CALL_ATTEMPTS)."""
    form = await request.form()
    status = form.get("CallStatus", "")
    if (status in ("no-answer", "busy", "failed", "canceled")
            and STATE["status"] == "CAREGIVER_CONTACTED"
            and STATE.get("call_attempts", 0) < MAX_CALL_ATTEMPTS):
        cg = PROFILE["caregiver"]["name"].split()[0]
        log("call", f"Call {status} — redialing in {REDIAL_DELAY_S}s",
            friendly=f"{cg} didn't pick up. Trying again in a moment…")

        def _redial():
            import time
            time.sleep(REDIAL_DELAY_S)
            if STATE["status"] == "CAREGIVER_CONTACTED":
                try:
                    _place_caregiver_call()
                except Exception as e:
                    log("error", f"Redial failed: {e}")

        threading.Thread(target=_redial, daemon=True).start()
    elif (status in ("no-answer", "busy", "failed")
          and STATE["status"] == "CAREGIVER_CONTACTED"):
        log("call", "No answer after max attempts — SMS remains the ask.",
            friendly="Couldn't reach them by phone — the text is still out.")
    return {"ok": True}


def _speak(key: str) -> str:
    """TwiML fragment: ElevenLabs clip when pre-generated, else Polly Neural."""
    name = (STATE.get("tts") or {}).get(key)
    if name:
        base = _os.environ.get("BASE_URL", "")
        return f"<Play>{base}/static/tts/{name}</Play>"
    text = _call_texts()[key]
    return f'<Say voice="Polly.Joanna-Neural">{text}</Say>'


def _schedule_redial(reason: str):
    """Redial after a short pause if attempts remain and we're still waiting."""
    if STATE.get("call_attempts", 0) >= MAX_CALL_ATTEMPTS:
        log("call", f"{reason} — max attempts reached.",
            friendly="Couldn't reach them by phone — the text is still out.")
        return
    cg = PROFILE["caregiver"]["name"].split()[0]
    log("call", f"{reason} — redialing in {REDIAL_DELAY_S}s",
        friendly=f"{cg} didn't pick up. Trying again in a moment…")

    def _redial():
        import time
        time.sleep(REDIAL_DELAY_S)
        if STATE["status"] == "CAREGIVER_CONTACTED":
            try:
                _place_caregiver_call()
            except Exception as e:
                log("error", f"Redial failed: {e}")

    threading.Thread(target=_redial, daemon=True).start()


VOICEMAIL_MARKERS = ("voice messaging system", "voicemail", "mailbox",
                     "leave a message", "leave your message", "is not "
                     "available", "after the tone", "after the beep",
                     "record your message")


@app.post("/voice-twiml")
async def voice_twiml(request: Request, retry: int = 0):
    """TwiML Twilio fetches when the caregiver answers: ask the question,
    gather the spoken reply. If nothing is heard, re-prompt once (retry=1)
    before giving up. Machine pickups (AnsweredBy) are hung up and redialed
    so a voicemail greeting is never treated as the caregiver's answer."""
    form = await request.form()
    answered_by = form.get("AnsweredBy", "")
    if answered_by.startswith("machine") or answered_by == "fax":
        _schedule_redial(f"Voicemail answered ({answered_by})")
        return _Response(
            content='<?xml version="1.0" encoding="UTF-8"?>'
                    '<Response><Hangup/></Response>',
            media_type="text/xml")
    if retry:
        fallback = _speak("giveup")
    else:
        fallback = '<Redirect method="POST">/voice-twiml?retry=1</Redirect>'
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/voice-result" method="POST"
          timeout="8" speechTimeout="2">
    {_speak("retry" if retry else "ask")}
  </Gather>
  {fallback}
</Response>"""
    return _Response(content=xml, media_type="text/xml")


@app.post("/voice-result")
async def voice_result(request: Request):
    """Gather callback: Twilio posts the speech transcription here. It feeds
    the exact same Gemma interpretation worker the SMS webhook uses."""
    form = await request.form()
    text = form.get("SpeechResult", "")
    cg = PROFILE["caregiver"]["name"].split()[0]
    # Second line of defense: a voicemail greeting that slipped past AMD
    # must never be interpreted as the caregiver's answer.
    if text and any(m in text.lower() for m in VOICEMAIL_MARKERS):
        _schedule_redial("Transcript looks like voicemail")
        return _Response(
            content='<?xml version="1.0" encoding="UTF-8"?>'
                    '<Response><Hangup/></Response>',
            media_type="text/xml")
    if text and STATE["status"] == "CAREGIVER_CONTACTED":
        STATE["sms_outbox"].append({
            "to": "Relage", "phone": "", "time": "",
            "body": f"🎙 {cg} said (on the call): “{text}”", "via": "voice"})
        threading.Thread(target=_caregiver_worker, args=(text,),
                         daemon=True).start()
        speak = _speak("thanks")
    else:
        speak = '<Say voice="Polly.Joanna-Neural">Thank you. Goodbye.</Say>'
    xml = (f'<?xml version="1.0" encoding="UTF-8"?><Response>'
           f'{speak}</Response>')
    return _Response(content=xml, media_type="text/xml")


@app.post("/reset")
def reset():
    """Reset demo state (handy between demo runs)."""
    STATE.update({
        "status": "NEEDS_APPOINTMENT", "activity": [], "appointment": None,
        "transport_options": [], "transport": None, "caregiver_reply": None,
        "plan_explanation": "", "sms_outbox": [], "busy": False,
        "tts": {}, "call_attempts": 0,
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
