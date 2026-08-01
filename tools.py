"""Deterministic tools the Relage agent can invoke.

Gemma plans WHICH tool to call next; these functions do the actual work
against synthetic datasets (this is a hackathon — no real patient data, no
real provider APIs). Each tool returns plain dicts that feed back into the
coordination state machine.

SMS: by default messages go to the in-app phone simulator so the demo has no
external dependency. If TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
TWILIO_FROM / CAREGIVER_PHONE are set, outbound messages also go through
real Twilio SMS. Privacy note: only the minimum fields needed for the
approved action are ever included in an outbound message — never the
profile, history, or insurance details.
"""

import json
import os
import datetime
from pathlib import Path

DATA = Path(__file__).parent / "data"

# Load .env if present so Twilio credentials can live outside the repo.
_env_file = Path(__file__).parent / ".env"
if _env_file.exists():
    for line in _env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"'))

with open(DATA / "providers.json") as f:
    PROVIDERS = json.load(f)
with open(DATA / "transport.json") as f:
    TRANSPORT = json.load(f)


def search_providers(specialty: str, insurance: str, preferred: str = "") -> list:
    """Find providers matching specialty and insurance, preferred first."""
    matches = [
        p for p in PROVIDERS
        if p["specialty"] == specialty and insurance in p["accepts"]
    ]
    matches.sort(key=lambda p: (p["name"] != preferred, p["distance_miles"]))
    return matches


def check_availability(provider_name: str, preferred_times: list) -> dict | None:
    """Return the first slot matching the patient's preferred times."""
    provider = next((p for p in PROVIDERS if p["name"] == provider_name), None)
    if not provider:
        return None
    want_morning = any("morning" in t for t in preferred_times)
    for slot in provider["slots"]:
        is_morning = "AM" in slot["time"]
        if not want_morning or is_morning:
            return {**slot, "provider": provider_name,
                    "distance_miles": provider["distance_miles"]}
    return None


def hold_appointment(slot: dict) -> dict:
    """Tentatively hold a slot. Nothing is finalized until the patient confirms."""
    return {**slot, "status": "held"}


def check_transport(distance_miles: int, mobility_needs: list,
                    appointment_time: str) -> list:
    """Find transport options that cover the distance and mobility needs."""
    needs_walker = "walker" in mobility_needs
    options = []
    for t in TRANSPORT:
        if t["service_area_miles"] < distance_miles:
            continue
        if needs_walker and not t["walker_accommodation"]:
            continue
        pickup = _offset_time(appointment_time, -t["pickup_lead_minutes"])
        ret = _offset_time(appointment_time, t["return_wait_minutes"])
        options.append({**t, "pickup_time": pickup, "return_pickup_time": ret})
    return options


def reserve_transport(option: dict) -> dict:
    """Reserve a transport option (synthetic — marks it reserved)."""
    return {**option, "status": "reserved"}


def create_calendar_event(events: list, event: dict) -> list:
    """Append an event to the care timeline, kept chronologically sorted."""
    events.append(event)
    events.sort(key=lambda e: (e["date"], _to_24h(e.get("time", "12:00 PM"))))
    return events


def twilio_configured() -> bool:
    return all(os.environ.get(k) for k in
               ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"))


def send_sms(to_name: str, to_phone: str, body: str, outbox: list) -> dict:
    """Send an SMS. Always lands in the in-app simulator outbox; also sends
    through Twilio (to the phone number stored in the profile) when
    credentials are configured."""
    msg = {
        "to": to_name,
        "phone": to_phone,
        "body": body,
        "time": datetime.datetime.now().strftime("%-I:%M %p"),
        "via": "simulator",
    }
    sid = os.environ.get("TWILIO_ACCOUNT_SID")
    token = os.environ.get("TWILIO_AUTH_TOKEN")
    from_num = os.environ.get("TWILIO_FROM")
    # Real texts go to the number in the profile (E.164, e.g. +15551234567);
    # CAREGIVER_PHONE env overrides for testing.
    real_to = os.environ.get("CAREGIVER_PHONE") or to_phone
    looks_real = real_to.startswith("+") and "555-" not in real_to
    sms_disabled = os.environ.get("TWILIO_SMS_DISABLED")  # e.g. A2P-blocked number
    if sid and token and from_num and looks_real and not sms_disabled:
        try:
            import urllib.request, urllib.parse, base64
            url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
            data = urllib.parse.urlencode(
                {"To": real_to, "From": from_num, "Body": body}).encode()
            req = urllib.request.Request(url, data=data)
            auth = base64.b64encode(f"{sid}:{token}".encode()).decode()
            req.add_header("Authorization", f"Basic {auth}")
            urllib.request.urlopen(req, timeout=10)
            msg["via"] = "twilio"
        except Exception:
            msg["via"] = "simulator (twilio failed)"
    outbox.append(msg)
    return msg


def place_call(to_phone: str, twiml_url: str) -> dict:
    """Place a real phone call through Twilio Voice. The call fetches its
    TwiML (what to say, how to gather the spoken answer) from twiml_url."""
    import urllib.request, urllib.parse, base64
    sid = os.environ["TWILIO_ACCOUNT_SID"]
    token = os.environ["TWILIO_AUTH_TOKEN"]
    from_num = os.environ["TWILIO_FROM"]
    url = f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Calls.json"
    data = urllib.parse.urlencode(
        {"To": to_phone, "From": from_num, "Url": twiml_url,
         "Method": "POST"}).encode()
    req = urllib.request.Request(url, data=data)
    auth = base64.b64encode(f"{sid}:{token}".encode()).decode()
    req.add_header("Authorization", f"Basic {auth}")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def _offset_time(time_str: str, minutes: int) -> str:
    t = datetime.datetime.strptime(time_str, "%I:%M %p")
    return (t + datetime.timedelta(minutes=minutes)).strftime("%-I:%M %p")


def _to_24h(time_str: str) -> str:
    try:
        return datetime.datetime.strptime(time_str, "%I:%M %p").strftime("%H:%M")
    except ValueError:
        return "12:00"
