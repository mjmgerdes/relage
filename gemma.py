"""Gemma interface for Relage.

All model inference runs locally through Ollama (default: gemma4). The
application never sends the patient profile to a cloud model — this module is
the only place inference happens, and it talks to localhost.

Gemma is used in five places:
  1. interpret_onboarding  — free-text answers -> structured preferences
  2. plan_next_action      — choose the next tool given coordination state
  3. interpret_reply       — caregiver SMS text -> structured availability
  4. replan                — react when a caregiver or option falls through
  5. explain_plan          — plain-language explanation of the proposed plan

Every Gemma output is JSON-constrained and validated by the caller. If the
model returns something invalid, callers fall back to deterministic logic so
the coordination state machine never stalls.
"""

import json
import urllib.request

OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL = "gemma4:latest"

SYSTEM = (
    "You are the planning core of Relage, a care-access coordination "
    "agent for older adults in rural areas. You handle logistics only: "
    "appointments, transportation, caregiver outreach, reminders. You never "
    "diagnose, recommend medical care, or give treatment advice. "
    "Always respond with valid JSON matching the requested schema exactly."
)


def _chat(prompt: str, timeout: int = 60) -> dict:
    """Send one JSON-constrained chat request to local Gemma via Ollama."""
    body = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": prompt},
        ],
        "format": "json",
        "stream": False,
        "options": {"temperature": 0.1},
    }).encode()
    req = urllib.request.Request(
        OLLAMA_URL, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.load(resp)
    return json.loads(data["message"]["content"])


def interpret_onboarding(free_text: str) -> dict:
    """Convert a conversational onboarding answer into structured preferences."""
    return _chat(
        "A patient or caregiver said during onboarding:\n"
        f'"{free_text}"\n\n'
        "Extract structured preferences. Respond with JSON:\n"
        '{"preferences": [{"field": "<one of: preferred_times, mobility_needs, '
        'transport_preference, caregiver_availability, other>", '
        '"value": "<short normalized value>"}], '
        '"summary": "<one sentence restating what was learned>"}'
    )


def plan_next_action(state: str, context: dict, allowed_tools: list) -> dict:
    """Choose the next tool call given the current coordination state.

    The state machine passes only the tools that are valid transitions from
    the current state, so Gemma plans within guardrails.
    """
    return _chat(
        f"Coordination state: {state}\n"
        f"Context:\n{json.dumps(context, indent=2)}\n\n"
        f"Allowed next tools: {allowed_tools}\n\n"
        "Pick the single best next tool and say why in one sentence. "
        'Respond with JSON: {"tool": "<one allowed tool>", '
        '"reason": "<one sentence>"}'
    )


def interpret_reply(sms_text: str, request_context: str) -> dict:
    """Convert a caregiver's free-text SMS reply into structured availability."""
    return _chat(
        f"We texted a caregiver: \"{request_context}\"\n"
        f"The caregiver replied: \"{sms_text}\"\n\n"
        "Interpret the reply. Respond with JSON:\n"
        '{"can_drive": true|false, '
        '"partial": true|false, '
        '"constraint": "<any stated constraint, or empty string>", '
        '"summary": "<one sentence for the patient dashboard>"}'
    )


def replan(failed_step: str, context: dict, options: list) -> dict:
    """Pick a fallback when the preferred option falls through."""
    return _chat(
        f"The step '{failed_step}' fell through.\n"
        f"Context:\n{json.dumps(context, indent=2)}\n"
        f"Available fallback options:\n{json.dumps(options, indent=2)}\n\n"
        "Choose the best fallback for this patient given mobility needs and "
        "distance. Respond with JSON:\n"
        '{"choice_index": <0-based index into options>, '
        '"reason": "<one sentence>"}'
    )


def explain_plan(plan: dict, profile: dict) -> dict:
    """Explain the proposed plan in plain language for the patient."""
    return _chat(
        f"Proposed care plan:\n{json.dumps(plan, indent=2)}\n"
        f"Patient preferences: {json.dumps(profile.get('patient', {}))}\n\n"
        "Explain in 2-3 warm, plain sentences why this plan fits the "
        "patient's needs and preferences. No medical advice. "
        'Respond with JSON: {"explanation": "<2-3 sentences>"}'
    )
